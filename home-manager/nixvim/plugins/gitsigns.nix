_: {
  programs.nixvim.plugins.gitsigns = {
    enable = true;

    # All keybindings are buffer-local via on_attach — they only activate
    # in git-tracked files. Hunk navigation falls back to built-in ]c/[c
    # in diff mode.
    settings.on_attach = ''
      function(bufnr)
        local gitsigns = require('gitsigns')

        local function map(mode, l, r, opts)
          opts = opts or {}
          opts.buffer = bufnr
          vim.keymap.set(mode, l, r, opts)
        end

        -- Hunk navigation (diff-mode aware)
        map('n', ']c', function()
          if vim.wo.diff then
            vim.cmd.normal({']c', bang = true})
          else
            gitsigns.nav_hunk('next')
          end
        end, { desc = 'Next hunk' })

        map('n', '[c', function()
          if vim.wo.diff then
            vim.cmd.normal({'[c', bang = true})
          else
            gitsigns.nav_hunk('prev')
          end
        end, { desc = 'Previous hunk' })

        -- Stage / Reset
        map('n', '<leader>gs', gitsigns.stage_hunk, { desc = 'Stage hunk' })
        map('n', '<leader>gr', gitsigns.reset_hunk, { desc = 'Reset hunk' })
        map('v', '<leader>gs', function()
          gitsigns.stage_hunk({ vim.fn.line('.'), vim.fn.line('v') })
        end, { desc = 'Stage hunk' })
        map('v', '<leader>gr', function()
          gitsigns.reset_hunk({ vim.fn.line('.'), vim.fn.line('v') })
        end, { desc = 'Reset hunk' })

        -- Buffer-level operations
        map('n', '<leader>gS', gitsigns.stage_buffer, { desc = 'Stage buffer' })
        map('n', '<leader>gR', gitsigns.reset_buffer, { desc = 'Reset buffer' })
        map('n', '<leader>gu', gitsigns.undo_stage_hunk, { desc = 'Undo stage hunk' })

        -- View / Inspect
        map('n', '<leader>gp', gitsigns.preview_hunk, { desc = 'Preview hunk' })
        map('n', '<leader>gb', function()
          gitsigns.blame_line({ full = true })
        end, { desc = 'Blame line (full)' })
        map('n', '<leader>gd', function()
          gitsigns.diffthis('HEAD')
        end, { desc = 'Diff against HEAD' })

        -- Toggle (under Display Toggles group)
        map('n', '<leader>Vb', gitsigns.toggle_current_line_blame, { desc = 'Toggle line blame' })

        -- Text object: inner hunk
        map({'o', 'x'}, 'ih', gitsigns.select_hunk, { desc = 'Select hunk' })
      end
    '';
  };
}
