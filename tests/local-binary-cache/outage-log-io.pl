#!/usr/bin/perl

use strict;
use warnings;

use Errno qw(EINTR EPERM ESRCH);
use Fcntl qw(
  LOCK_EX LOCK_NB O_CREAT O_EXCL O_NONBLOCK O_NOFOLLOW O_RDONLY O_RDWR
  SEEK_SET S_ISREG
);
use IO::Handle ();
use IO::Select ();
use POSIX qw(
  SIG_BLOCK SIG_SETMASK SIGHUP SIGINT SIGTERM WNOHANG _exit setpgid sigaction
  sigprocmask
);
use Time::HiRes qw(CLOCK_MONOTONIC clock_gettime sleep);

my $MAX_OUTPUT_BYTES = 64 * 1024;
my $PRODUCTION_TIMEOUT_SECONDS = 180;
my @ROOT_LAUNCHD_ENVIRONMENT = (
    'HOME=/var/root',
    'LOGNAME=root',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    'SHELL=/bin/sh',
    'USER=root',
);
my $test_mode = $> != 0 && ($ENV{LOCAL_BINARY_CACHE_RUNNER_TEST_MODE} // '') eq '1';
my $timeout_seconds = $PRODUCTION_TIMEOUT_SECONDS;
if ($test_mode && defined($ENV{LOCAL_BINARY_CACHE_RUNNER_TEST_TIMEOUT})) {
    my $candidate = $ENV{LOCAL_BINARY_CACHE_RUNNER_TEST_TIMEOUT};
    $candidate =~ /\A(?:0\.[0-9]+|[1-5](?:\.[0-9]+)?)\z/
      or fail_closed(64, 'invalid test timeout');
    $timeout_seconds = 0 + $candidate;
    $timeout_seconds >= 0.05 && $timeout_seconds <= 5
      or fail_closed(64, 'test timeout is out of range');
}

sub fail_closed {
    my ($status, $message) = @_;
    print STDERR "outage-publisher-runner: $message\n";
    exit $status;
}

sub operation_failed {
    my ($on_failure, $status, $message) = @_;
    if (defined($on_failure)) {
        $on_failure->($status, $message);
        die "publisher failure handler returned\n";
    }
    fail_closed($status, $message);
}

sub descriptor_state {
    my ($handle, $on_failure) = @_;
    my @state;
    while (1) {
        @state = stat($handle);
        last if @state;
        next if $! == EINTR;
        operation_failed($on_failure, 68, "fstat failed: $!");
    }
    S_ISREG($state[2])
      or operation_failed($on_failure, 65, 'file descriptor is not regular');
    return @state;
}

sub require_private_owner {
    my ($on_failure, @state) = @_;
    ($state[2] & 0777) == 0600
      or operation_failed($on_failure, 65, 'file mode is not 0600');
    if ($> == 0) {
        $state[4] == 0
          or operation_failed($on_failure, 65, 'file is not root-owned');
    } elsif (!$test_mode) {
        operation_failed($on_failure, 65, 'runner must execute as root');
    }
}

sub write_all {
    my ($handle, $content, $on_failure) = @_;
    my $offset = 0;
    while ($offset < length($content)) {
        my $written = syswrite($handle, $content, length($content) - $offset, $offset);
        if (!defined($written)) {
            next if $! == EINTR;
            operation_failed($on_failure, 68, "write failed: $!");
        }
        $written > 0 or operation_failed($on_failure, 68, 'write returned zero');
        $offset += $written;
    }
}

sub read_all_bounded {
    my ($handle, $limit, $on_failure) = @_;
    while (!defined(sysseek($handle, 0, SEEK_SET))) {
        next if $! == EINTR;
        operation_failed($on_failure, 68, "seek failed: $!");
    }
    my $content = '';
    while (1) {
        my $buffer = '';
        my $read = sysread($handle, $buffer, 8192);
        if (!defined($read)) {
            next if $! == EINTR;
            operation_failed($on_failure, 68, "read failed: $!");
        }
        last if $read == 0;
        length($content) + $read <= $limit
          or operation_failed($on_failure, 125, 'capture exceeded output bound');
        $content .= substr($buffer, 0, $read);
    }
    return $content;
}

sub sync_handle {
    my ($handle, $on_failure, $description) = @_;
    while (1) {
        return if $handle->sync;
        next if $! == EINTR;
        operation_failed($on_failure, 68, "$description: $!");
    }
}

sub close_handle {
    my ($handle, $on_failure, $description) = @_;
    close($handle) or operation_failed($on_failure, 68, "$description: $!");
}

sub readable_handles {
    my ($selector, $timeout, $on_failure, $description) = @_;
    my $deadline = clock_gettime(CLOCK_MONOTONIC) + $timeout;
    while (1) {
        my $remaining = $deadline - clock_gettime(CLOCK_MONOTONIC);
        return () if $remaining <= 0;
        local $! = 0;
        my @ready = $selector->can_read($remaining);
        my $error = 0 + $!;
        my $error_text = "$!";
        return @ready if @ready;
        return () if $error == 0;
        next if $error == EINTR;
        operation_failed($on_failure, 68, "$description: $error_text");
    }
}

sub open_exclusive_private {
    my ($path) = @_;
    sysopen(my $handle, $path, O_RDWR | O_CREAT | O_EXCL | O_NONBLOCK | O_NOFOLLOW, 0600)
      or fail_closed(65, "cannot create exclusive file: $!");
    binmode($handle) or fail_closed(68, "cannot set binary mode: $!");
    my @state = descriptor_state($handle, undef);
    require_private_owner(undef, @state);
    return ($handle, @state);
}

sub reap_publisher {
    my ($process, $blocking) = @_;
    return 1 if $process->{reaped};

    while (1) {
        my $waited = waitpid($process->{pid}, $blocking ? 0 : WNOHANG);
        if ($waited == $process->{pid}) {
            $process->{status} = $?;
            $process->{reaped} = 1;
            return 1;
        }
        return 0 if $waited == 0;
        next if $! == EINTR;
        $process->{wait_error} = "$!";
        return undef;
    }
}

sub publisher_group_alive {
    my ($process) = @_;
    while (1) {
        local $! = 0;
        return 1 if kill(0, -$process->{pid}) > 0;
        return 0 if $! == ESRCH;
        next if $! == EINTR;
        return 1 if $! == EPERM;
        return 1;
    }
}

sub signal_process {
    my ($signal, $target) = @_;
    while (1) {
        local $! = 0;
        return 1 if kill($signal, $target) > 0;
        return 1 if $! == ESRCH;
        next if $! == EINTR;
        return 0;
    }
}

sub terminate_group {
    my ($process) = @_;
    return 1 unless defined($process);
    return 1 if $process->{cleanup_complete};
    return 0 if $process->{cleanup_attempted};
    return 0 if $process->{cleanup_running};

    $process->{cleanup_running} = 1;
    $process->{cleanup_attempted} = 1;
    sleep(0.2)
      if $test_mode
      && ($ENV{LOCAL_BINARY_CACHE_RUNNER_TEST_CLEANUP_DELAY} // '') eq '1';

    my $pid = $process->{pid};
    if (publisher_group_alive($process) && !signal_process('TERM', -$pid)) {
        $process->{cleanup_error} = "cannot terminate publisher process group: $!";
    }
    if (!$process->{reaped} && !signal_process('TERM', $pid)) {
        $process->{cleanup_error} //= "cannot terminate publisher process: $!";
    }
    my $deadline = clock_gettime(CLOCK_MONOTONIC) + 0.5;
    while (clock_gettime(CLOCK_MONOTONIC) < $deadline) {
        if (!$process->{reaped} && !defined(reap_publisher($process, 0))) {
            $process->{cleanup_error} //= "waitpid failed: $process->{wait_error}";
            last;
        }
        last if $process->{reaped} && !publisher_group_alive($process);
        sleep(0.02);
    }

    if (!$process->{reaped} || publisher_group_alive($process)) {
        if (publisher_group_alive($process) && !signal_process('KILL', -$pid)) {
            $process->{cleanup_error} //= "cannot kill publisher process group: $!";
        }
        if (!$process->{reaped} && !signal_process('KILL', $pid)) {
            $process->{cleanup_error} //= "cannot kill publisher process: $!";
        }
    }
    if (!$process->{reaped} && !defined(reap_publisher($process, 1))) {
        $process->{cleanup_error} //= "waitpid failed: $process->{wait_error}";
    }

    $deadline = clock_gettime(CLOCK_MONOTONIC) + 0.5;
    while (publisher_group_alive($process) && clock_gettime(CLOCK_MONOTONIC) < $deadline) {
        sleep(0.02);
    }

    my $complete = $process->{reaped} && !publisher_group_alive($process);
    $process->{cleanup_running} = 0;
    $process->{cleanup_complete} = 1 if $complete;
    return $complete;
}

sub child_exit_code {
    my ($status) = @_;
    return 128 + ($status & 127) if ($status & 127) != 0;
    return ($status >> 8) & 255;
}

sub run_publisher {
    my ($expectation, $capture, $working_directory, $fragment_count, @arguments) = @_;
    ($expectation eq 'zero' || $expectation eq 'nonzero')
      or fail_closed(64, 'expectation must be zero or nonzero');
    $fragment_count =~ /\A[0-9]+\z/ or fail_closed(64, 'invalid fragment count');
    $fragment_count = 0 + $fragment_count;
    $fragment_count > 0 && @arguments > $fragment_count
      or fail_closed(64, 'missing evidence fragments or command');
    my @fragments = splice(@arguments, 0, $fragment_count);
    shift(@arguments) eq '--' or fail_closed(64, 'missing command separator');
    @arguments > 0 or fail_closed(64, 'missing command');
    $arguments[0] =~ m{\A/} or fail_closed(64, 'command path must be absolute');
    for my $fragment (@fragments) {
        length($fragment) > 0 or fail_closed(64, 'evidence fragment must be nonempty');
    }

    my $started = clock_gettime(CLOCK_MONOTONIC);
    my ($capture_handle, @initial_state) = open_exclusive_private($capture);
    pipe(my $read_pipe, my $write_pipe) or fail_closed(68, "pipe failed: $!");
    pipe(my $group_read, my $group_write) or fail_closed(68, "group pipe failed: $!");
    binmode($read_pipe);
    binmode($write_pipe);

    my $blocked_signals = POSIX::SigSet->new(SIGHUP, SIGINT, SIGTERM);
    my $previous_signals = POSIX::SigSet->new();
    defined(sigprocmask(SIG_BLOCK, $blocked_signals, $previous_signals))
      or fail_closed(68, "cannot block runner signals: $!");
    my $publisher_process;
    my $post_fork_failure;
    my @signal_actions;
    for my $signal_spec (
        [SIGHUP, 129, 'publisher invocation interrupted by HUP'],
        [SIGINT, 130, 'publisher invocation interrupted by INT'],
        [SIGTERM, 143, 'publisher invocation interrupted by TERM'],
    ) {
        my ($signal, $status, $message) = @{$signal_spec};
        my $action = POSIX::SigAction->new(
            sub { $post_fork_failure->($status, $message) },
            $blocked_signals,
            0
        );
        defined(sigaction($signal, $action)) or do {
            sigprocmask(SIG_SETMASK, $previous_signals);
            fail_closed(68, "cannot install runner signal handler: $!");
        };
        push(@signal_actions, $action);
    }
    my $pid;
    while (1) {
        $pid = fork();
        last if defined($pid);
        next if $! == EINTR;
        sigprocmask(SIG_SETMASK, $previous_signals);
        fail_closed(68, "fork failed: $!");
    }
    if ($pid == 0) {
        $SIG{HUP} = 'DEFAULT';
        $SIG{INT} = 'DEFAULT';
        $SIG{TERM} = 'DEFAULT';
        defined(sigprocmask(SIG_SETMASK, $previous_signals)) or _exit(126);
        close($read_pipe);
        close($group_read);
        while (setpgid(0, 0) != 0) {
            next if $! == EINTR;
            _exit(126);
        }
        while (1) {
            my $written = syswrite($group_write, '1', 1);
            last if defined($written) && $written == 1;
            next if !defined($written) && $! == EINTR;
            _exit(126);
        }
        close($group_write);
        %ENV = map { split(/=/, $_, 2) } @ROOT_LAUNCHD_ENVIRONMENT;
        umask(0022);
        chdir($working_directory) or _exit(126);
        open(STDIN, '<', '/dev/null') or _exit(126);
        open(STDOUT, '>&', $write_pipe) or _exit(126);
        open(STDERR, '>&', $write_pipe) or _exit(126);
        close($write_pipe);
        close($capture_handle);
        exec { $arguments[0] } @arguments or _exit(127);
    }

    $publisher_process = {
        cleanup_attempted => 0,
        cleanup_complete => 0,
        cleanup_running  => 0,
        group_ready      => 0,
        pid              => $pid,
        reaped           => 0,
    };
    my $first_failure_status;
    my $first_failure_message;
    $post_fork_failure = sub {
        my ($status, $message) = @_;
        my $cleanup_previous_signals = POSIX::SigSet->new();
        defined(sigprocmask(
            SIG_BLOCK,
            $blocked_signals,
            $cleanup_previous_signals
        )) or fail_closed($status, "$message; cannot block cleanup signals: $!");
        if (!defined($first_failure_status)) {
            $first_failure_status = $status;
            $first_failure_message = $message;
        }
        if (!terminate_group($publisher_process)) {
            my $detail = $publisher_process->{cleanup_error}
              // $publisher_process->{wait_error};
            $first_failure_message .= '; publisher process-group cleanup failed';
            $first_failure_message .= ": $detail" if defined($detail);
        }
        $SIG{HUP} = 'IGNORE';
        $SIG{INT} = 'IGNORE';
        $SIG{TERM} = 'IGNORE';
        defined(sigprocmask(SIG_SETMASK, $previous_signals))
          or $first_failure_message .= "; cannot finalize cleanup signal mask: $!";
        fail_closed($first_failure_status, $first_failure_message);
    };

    close_handle($write_pipe, $post_fork_failure, 'cannot close parent output pipe');
    close_handle($group_write, $post_fork_failure, 'cannot close parent group pipe');
    my $group_selector = IO::Select->new($group_read);
    my @group_handles = readable_handles(
        $group_selector,
        1,
        $post_fork_failure,
        'publisher group handshake select failed'
    );
    if (!@group_handles) {
        $post_fork_failure->(
            68,
            'publisher child did not establish a process group'
        );
    }
    my $group_ready = '';
    my $group_read_status;
    while (1) {
        $group_read_status = sysread($group_read, $group_ready, 1);
        last if defined($group_read_status);
        next if $! == EINTR;
        $post_fork_failure->(68, "publisher child process group handshake read failed: $!");
    }
    close_handle($group_read, $post_fork_failure, 'cannot close group handshake pipe');
    if ($group_read_status != 1 || $group_ready ne '1') {
        $post_fork_failure->(
            68,
            'publisher child process group handshake failed'
        );
    }
    $publisher_process->{group_ready} = 1;
    defined(sigprocmask(SIG_SETMASK, $previous_signals))
      or $post_fork_failure->(68, "cannot restore runner signals: $!");

    my $selector = IO::Select->new($read_pipe);
    my $total = 0;
    my $pipe_open = 1;
    while (1) {
        if (clock_gettime(CLOCK_MONOTONIC) - $started >= $timeout_seconds) {
            $post_fork_failure->(124, 'publisher invocation timed out');
        }

        for my $handle (readable_handles(
            $selector,
            0.02,
            $post_fork_failure,
            'publisher output select failed'
        )) {
            my $buffer = '';
            my $read;
            while (1) {
                $read = sysread($handle, $buffer, 8192);
                last if defined($read);
                next if $! == EINTR;
                $post_fork_failure->(68, "publisher output read failed: $!");
            }
            if ($read == 0) {
                $selector->remove($handle);
                close_handle($handle, $post_fork_failure, 'cannot close publisher output pipe');
                $pipe_open = 0;
                next;
            }
            my $remaining = $MAX_OUTPUT_BYTES - $total;
            if ($read > $remaining) {
                write_all(
                    $capture_handle,
                    substr($buffer, 0, $remaining),
                    $post_fork_failure
                ) if $remaining > 0;
                $post_fork_failure->(
                    125,
                    'publisher output exceeded 64 KiB'
                );
            }
            write_all($capture_handle, substr($buffer, 0, $read), $post_fork_failure);
            $total += $read;
        }

        if (!$publisher_process->{reaped}) {
            defined(reap_publisher($publisher_process, 0))
              or $post_fork_failure->(
                68,
                "publisher wait failed: $publisher_process->{wait_error}"
              );
        }
        if ($publisher_process->{reaped} && !$publisher_process->{cleanup_attempted}) {
            my $cleanup_previous_signals = POSIX::SigSet->new();
            defined(sigprocmask(
                SIG_BLOCK,
                $blocked_signals,
                $cleanup_previous_signals
            )) or $post_fork_failure->(68, "cannot block cleanup signals: $!");
            terminate_group($publisher_process)
              or $post_fork_failure->(70, 'publisher process-group finalization failed');
            defined(sigprocmask(SIG_SETMASK, $cleanup_previous_signals))
              or $post_fork_failure->(68, "cannot restore cleanup signal mask: $!");
        }
        last if $publisher_process->{reaped} && !$pipe_open;
    }

    sync_handle($capture_handle, $post_fork_failure, 'capture sync failed');
    my @final_state = descriptor_state($capture_handle, $post_fork_failure);
    require_private_owner($post_fork_failure, @final_state);
    $final_state[0] == $initial_state[0] && $final_state[1] == $initial_state[1]
      or $post_fork_failure->(65, 'capture descriptor identity changed');
    $final_state[7] <= $MAX_OUTPUT_BYTES
      or $post_fork_failure->(125, 'capture exceeded output bound');

    my @path_state;
    while (1) {
        @path_state = lstat($capture);
        last if @path_state;
        next if $! == EINTR;
        $post_fork_failure->(65, "capture path disappeared: $!");
    }
    S_ISREG($path_state[2])
      or $post_fork_failure->(65, 'capture path is not regular');
    $path_state[0] == $final_state[0] && $path_state[1] == $final_state[1]
      or $post_fork_failure->(65, 'capture path was replaced');

    my $content = read_all_bounded(
        $capture_handle,
        $MAX_OUTPUT_BYTES,
        $post_fork_failure
    );
    close_handle($capture_handle, $post_fork_failure, 'cannot close capture');
    for my $fragment (@fragments) {
        index($content, $fragment) >= 0
          or $post_fork_failure->(69, 'capture is missing required evidence');
    }

    my $exit_code = child_exit_code($publisher_process->{status});
    if ($expectation eq 'zero') {
        $exit_code == 0
          or $post_fork_failure->(69, "publisher exit was $exit_code, expected zero");
    } else {
        $exit_code > 0 && $exit_code < 124
          or $post_fork_failure->(
            69,
            "publisher exit was $exit_code, expected bounded nonzero"
          );
    }
    print "publisher-exit=$exit_code capture=$capture bytes=$final_state[7]\n"
      or $post_fork_failure->(68, "cannot report publisher result: $!");
}

sub ticket_create {
    my ($path, $payload) = @_;
    length($payload) <= $MAX_OUTPUT_BYTES
      or fail_closed(65, 'run ticket payload exceeds safe bound');
    my ($handle) = open_exclusive_private($path);
    write_all($handle, $payload);
    sync_handle($handle, undef, 'ticket sync failed');
}

sub ticket_consume {
    my ($path, $consumed_path, $expected_payload) = @_;
    sysopen(my $handle, $path, O_RDWR | O_NONBLOCK | O_NOFOLLOW)
      or fail_closed(65, "cannot open run ticket: $!");
    binmode($handle);
    my @state = descriptor_state($handle, undef);
    require_private_owner(undef, @state);
    flock($handle, LOCK_EX | LOCK_NB) or fail_closed(65, 'cannot lock run ticket');
    my $payload = read_all_bounded($handle, $MAX_OUTPUT_BYTES);
    $payload eq $expected_payload or fail_closed(69, 'run ticket payload mismatch');
    link($path, $consumed_path) or fail_closed(65, "cannot claim run ticket: $!");
    my @consumed_state = lstat($consumed_path);
    @consumed_state && S_ISREG($consumed_state[2])
      or fail_closed(65, 'consumed ticket path is not regular');
    $consumed_state[0] == $state[0] && $consumed_state[1] == $state[1]
      or fail_closed(65, 'consumed ticket identity changed');
    unlink($path) or fail_closed(65, "cannot finalize run ticket consumption: $!");
}

my $operation = shift(@ARGV) // '';
if ($operation eq 'run' && @ARGV >= 6) {
    run_publisher(@ARGV);
} elsif ($operation eq 'ticket-create' && @ARGV == 2) {
    ticket_create(@ARGV);
} elsif ($operation eq 'ticket-consume' && @ARGV == 3) {
    ticket_consume(@ARGV);
} else {
    fail_closed(64, 'invalid runner operation');
}
