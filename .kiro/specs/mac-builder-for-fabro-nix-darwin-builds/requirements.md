# Requirements Document

## Introduction

`mac-builder-for-fabro-nix-darwin-builds` defines how a Fabro run obtains
`aarch64-darwin` builds and checks from the Builder Host while every sandbox
keeps using the Fabro Guest's one Nix, and how that Builder Host joins the
tailnet and substitutes from public caches. See `brief.md` for the problem,
selected approach, and scope.

## Boundary Context

- **In scope**: dispatch from the Fabro Guest's Nix daemon to the Builder
  Host and the trust material on both sides; the Builder Host's tailnet
  membership, remote-builder service, and public substituter policy; the
  documented tailnet grant the Fabro Guest needs; declarative checks and the
  sandbox-side Darwin Build Smoke.
- **Out of scope**: selecting a builder per run, per workflow, or per pool;
  load balancing or scheduling policy across builders; tailnet policy
  administration beyond documenting the grant; live tailnet reachability
  verification inside repository checks; publishing Darwin outputs to any
  cache.
- **Adjacent expectations**: `mac-nix-remote-builder` keeps ownership of the
  Builder Host Configuration, the Builder User, the authorized-key mechanism,
  and the Builder Secret Store; the fabro-vm tailnet node registration and its
  OAuth client stay as they are; per-host sops stores, the Sandbox Host-Store
  Sharing, and the Sandbox Image environment remain unchanged in ownership.
- **Trust delegation**: the tailnet policy (Tailscale ACLs and tags) owns
  network reachability between the `fabro-vm` node and the Builder Host node.
  That is a network-level decision and does not authenticate a build session:
  the Build Client Key and the pinned Builder Host Key authenticate the session
  on the two sides. This spec therefore keeps the key material and delegates
  only reachability to Tailscale; a node the ACL admits without an authorized
  Build Client Key is still refused.

## Requirements

### Requirement 1: Darwin builds from a Fabro sandbox
**Objective:** As a Fabro operator, I want a Fabro run to build and check Darwin output from its existing sandbox, so that Darwin-specific work can be verified where agents run.

#### Acceptance Criteria
1. When a Fabro run requests an `aarch64-darwin` build from its Sandbox, the Fabro Guest shall perform that build on the Builder Host.
2. When a Fabro run requests an `aarch64-linux` build, the Fabro Guest shall perform that build locally.
3. When the Builder Host completes an `aarch64-darwin` build, the Fabro Guest shall place the produced output in its own Nix store.
4. While an `aarch64-darwin` output is present in the Fabro Guest's Nix store, the Sandbox shall resolve that output.
5. The Fabro Guest shall obtain `aarch64-darwin` output for a Fabro run without any workflow change by the run.
6. If the Builder Host cannot be reached, then the Fabro Guest shall fail the build request with an error identifying the failed connection to the Builder Host.
7. If the Builder Host rejects a build request, then the Fabro Guest shall fail the build request with an error identifying the rejection.

### Requirement 2: One Nix per sandbox
**Objective:** As a Fabro operator, I want every sandbox to keep using the Fabro Guest's Nix daemon and store, so that runs share one Nix identity and store.

#### Acceptance Criteria
1. The Nix operations of a Sandbox shall reach the Fabro Guest's Nix daemon.
2. A Sandbox shall read the Fabro Guest's Nix store without writing to it.
3. A Sandbox shall not run its own Nix daemon.
4. A Sandbox shall not keep a Nix store of its own.
5. A Sandbox shall not hold a Build Client Key.
6. A Sandbox shall not join the tailnet.
7. The Fabro Guest shall give every Sandbox this access without per-environment configuration.

### Requirement 3: Tailnet path to the Builder Host
**Objective:** As a Fabro operator, I want build traffic from the Fabro Guest to cross the tailnet, so that tailnet tags and ACLs decide whether the Builder Host is reachable.

#### Acceptance Criteria
1. When the Fabro Guest dispatches a build, the build traffic shall leave the Fabro Guest as the `fabro-vm` tailnet node.
2. The Fabro Guest shall address the Builder Host by its tailnet name.
3. The Fabro Guest's build dispatch shall not use the Builder Host's LAN forward or a DHCP address.
4. The repository shall document the tailnet grant that allows the `fabro-vm` node to reach the Builder Host's remote-builder port.
5. If the tailnet policy denies the Fabro Guest access to the Builder Host, then the Builder Host shall refuse the connection.
6. If the tailnet policy denies the Fabro Guest access to the Builder Host, then the Fabro Guest shall report the failure identifying the Builder Host's tailnet name.
7. The tailnet policy shall decide only whether the Fabro Guest can reach the Builder Host, and shall not authenticate the build session.
8. The Fabro Guest shall authenticate each build session independently of the tailnet policy.

### Requirement 4: Builder Host tailnet membership
**Objective:** As a builder operator, I want the Builder Host to join the tailnet on its own, so that the ACL sits on the builder node rather than on another host.

#### Acceptance Criteria
1. The Builder Host shall join the tailnet using the open-source Tailscale client.
2. The Builder Host shall not require the Tailscale macOS application.
3. The OAuth Credential shall be the Tailscale OAuth client credential issued for the Builder Host and authorized to grant the dedicated builder tag.
4. The Builder Host's OAuth Credential shall be separate from the Fabro Guest's tailnet credential.
5. The Builder Host shall hold no tailnet credential other than its OAuth Credential.
6. The Builder Host shall read the OAuth Credential from the Builder Secret Store at a root-only runtime path.
7. The Builder Host shall not place the OAuth Credential in the Nix store.
8. If the OAuth Credential is missing or empty, then the Builder Host shall not join the tailnet and shall report the missing credential with its runtime path.
9. The Builder Host shall join with the dedicated builder tag that the OAuth Credential is authorized to grant.
10. When the Builder Host starts, it shall establish tailnet membership without an interactive login.
11. If tailnet membership is lost, then the Builder Host shall reauthenticate with the OAuth Credential without an interactive login.
12. The Builder Host shall declare its tailnet membership, remote-builder service, and cache policy declaratively in the repository.
13. The Builder Host shall not join the tailnet through the Personal Host's tailnet node.
14. The Builder Host shall remain a nix-darwin host with no Home Manager configuration.

### Requirement 5: Stock remote-builder endpoint
**Objective:** As a Fabro operator, I want the Builder Host to serve Nix's existing distributed-build protocol, so that no bespoke build service is needed.

#### Acceptance Criteria
1. The Builder Host shall serve the stock Nix remote-builder protocol.
2. The Builder Host shall accept build connections only as the Builder User.
3. The Builder Host shall accept build requests only for `aarch64-darwin`.
4. If a build request targets a system other than `aarch64-darwin`, then the Builder Host shall reject the request.
5. When the Builder Host accepts a build request, the Builder Host shall perform the build and return the produced outputs to the requesting Nix daemon.
6. The Builder Host shall keep the remote builder available without an interactive login.
7. The Builder Host shall not substitute a custom build API, scheduler, or queue for Nix's distributed-build mechanism.

### Requirement 6: Build-session trust material
**Objective:** As a Fabro operator, I want each side to prove its identity with dedicated key material, so that tailnet reachability alone never admits a build session.

#### Acceptance Criteria
1. The Fabro Guest shall present a Build Client Key when it dispatches a build to the Builder Host.
2. The Builder Host shall accept the Build Client Key only when it matches the Builder Host's authorized build keys.
3. If a client presents a key that does not match the authorized build keys, then the Builder Host shall refuse the connection.
4. If a node the tailnet policy admits presents no authorized Build Client Key, then the Builder Host shall refuse the connection.
5. The Builder Host shall not treat tailnet node identity as authentication of a build session.
6. Before dispatching, the Fabro Guest shall verify the Builder Host Key presented by the Builder Host.
7. If the presented Builder Host Key does not match the pinned value, then the Fabro Guest shall refuse the connection.
8. The Build Client Key shall be readable only by root on the Fabro Guest.
9. The Build Client Key shall not be placed in the Nix store.
10. The Build Client Key shall not be placed in the Sandbox Image.
11. The Fabro Guest's builder configuration shall reference the Build Client Key by path rather than by value.
12. If the Build Client Key or the pinned Builder Host Key is unavailable, then the Fabro Guest shall fail the dispatch with an error identifying the missing material.
13. If the Builder Host's authorized build keys are missing or empty, then the Builder Host shall fail activation with an error identifying the missing material.

### Requirement 7: Public caches only on the Builder Host
**Objective:** As a builder operator, I want the Builder Host to substitute from public caches only, so that it never touches the private build cache.

#### Acceptance Criteria
1. The Builder Host shall substitute only from its declared public substituters.
2. The Builder Host shall trust only the trusted keys of its declared public substituters.
3. The Builder Host shall not reference the private binary cache or Attic.
4. The Builder Host shall not hold a credential for any private cache.
5. When the Builder Host needs an input that it does not hold, the Builder Host shall fetch that input from its own substituters rather than request it from the Fabro Guest.
6. While the Builder Host substitutes a build input, the Fabro Guest shall not upload that input to the Builder Host.
7. The Builder Host shall not publish build outputs to any cache.

### Requirement 8: Verification
**Objective:** As a repository maintainer, I want the dispatch, membership, trust, and cache behavior checked, so that drift is caught before a Darwin build is attempted.

#### Acceptance Criteria
1. When repository checks evaluate the Fabro Guest configuration, the Repository Checks shall verify the `aarch64-darwin` build-machine entry, its builder user, its pinned Builder Host Key, and its substitution policy.
2. When repository checks evaluate the Builder Host configuration, the Repository Checks shall verify the Tailscale service, the OAuth Credential's root-only runtime path and its separation from the Fabro Guest's credential, the builder tag, the authorized build keys, and the public substituters.
3. If rendered configuration artifacts contain a secret value, then the Repository Checks shall fail.
4. If the Fabro Guest configuration provides a per-container Nix daemon, a per-container Nix store, a builder key inside a Sandbox, or tailnet membership inside a Sandbox, then the Repository Checks shall fail.
5. When the operator runs the Darwin Build Smoke, the Darwin Build Smoke shall request a trivial `aarch64-darwin` derivation from a Sandbox and report the resulting store path.
6. When the Darwin Build Smoke completes, it shall confirm that the reported store path is present in the Fabro Guest's Nix store.
7. If a Darwin Build Smoke step fails, then the Darwin Build Smoke shall report the failed step and return a nonzero result.
