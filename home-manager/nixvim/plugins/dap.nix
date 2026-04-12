{
  pkgs,
  config,
  ...
}:
let
  helpers = config.lib.nixvim;
  codelldbPath = "${pkgs.vscode-extensions.vadimcn.vscode-lldb}/share/vscode/extensions/vadimcn.vscode-lldb/adapter/codelldb";
in
{
  programs.nixvim = {
    extraPackages = with pkgs; [
      delve
    ];

    plugins = {
      # Core DAP
      dap = {
        enable = true;

        signs = {
          dapBreakpoint = {
            text = "";
            texthl = "DiagnosticSignError";
          };
          dapBreakpointCondition = {
            text = "";
            texthl = "DiagnosticSignWarn";
          };
          dapLogPoint = {
            text = "";
            texthl = "DiagnosticSignInfo";
          };
          dapStopped = {
            text = "";
            texthl = "DiagnosticSignOk";
            linehl = "Visual";
          };
          dapBreakpointRejected = {
            text = "";
            texthl = "DiagnosticSignError";
          };
        };
      };

      # DAP UI — sidepanel with scopes, breakpoints, stacks, watches + bottom REPL/console
      dap-ui = {
        enable = true;

        settings = {
          controls.enabled = true;
          expand_lines = true;
          force_buffers = true;

          icons = {
            collapsed = "";
            current_frame = "";
            expanded = "";
          };

          layouts = [
            {
              elements = [
                {
                  id = "scopes";
                  size = 0.25;
                }
                {
                  id = "breakpoints";
                  size = 0.25;
                }
                {
                  id = "stacks";
                  size = 0.25;
                }
                {
                  id = "watches";
                  size = 0.25;
                }
              ];
              position = "left";
              size = 40;
            }
            {
              elements = [
                {
                  id = "repl";
                  size = 0.5;
                }
                {
                  id = "console";
                  size = 0.5;
                }
              ];
              position = "bottom";
              size = 10;
            }
          ];
        };
      };

      # Inline variable values during debug
      dap-virtual-text = {
        enable = true;

        settings = {
          enabled_commands = true;
          highlight_changed_variables = true;
          show_stop_reason = true;
          commented = false;
          only_first_definition = true;
          all_references = false;
          clear_on_continue = false;
        };
      };

      # Go: auto-configures delve adapter
      dap-go.enable = true;

      # Python: auto-configures debugpy adapter
      dap-python = {
        enable = true;
        settings.console = "integratedTerminal";
      };

      # Rust + C/C++: codelldb adapter via dap-lldb
      dap-lldb = {
        enable = true;
        settings.codelldb_path = codelldbPath;
      };

      # Rust: enhanced rust-analyzer integration with DAP support
      rustaceanvim = {
        enable = true;

        settings.dap.autoload_configurations = true;
      };
    };

    # DAP keybindings
    keymaps = [
      # Breakpoints
      {
        action = helpers.mkRaw "function() require('dap').toggle_breakpoint() end";
        key = "<leader>dt";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Toggle breakpoint";
        };
      }
      {
        action = helpers.mkRaw ''
          function()
            require('dap').set_breakpoint(vim.fn.input("Condition: "))
          end
        '';
        key = "<leader>dB";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Conditional breakpoint";
        };
      }

      # Execution control
      {
        action = helpers.mkRaw "function() require('dap').continue() end";
        key = "<leader>dc";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Continue";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').step_into() end";
        key = "<leader>di";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Step into";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').step_over() end";
        key = "<leader>do";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Step over";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').step_out() end";
        key = "<leader>du";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Step out";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').step_back() end";
        key = "<leader>db";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Step back";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').run_to_cursor() end";
        key = "<leader>dC";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Run to cursor";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').restart() end";
        key = "<leader>dr";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Restart";
        };
      }

      # Session management
      {
        action = helpers.mkRaw "function() require('dap').terminate() end";
        key = "<leader>dq";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Terminate";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').disconnect() end";
        key = "<leader>dd";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Disconnect";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap').pause() end";
        key = "<leader>dP";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Pause";
        };
      }

      # REPL and UI
      {
        action = helpers.mkRaw "function() require('dap').repl.toggle() end";
        key = "<leader>dR";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Toggle REPL";
        };
      }
      {
        action = helpers.mkRaw "function() require('dapui').toggle() end";
        key = "<leader>dU";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Toggle DAP UI";
        };
      }

      # Eval / inspect
      {
        action = helpers.mkRaw "function() require('dapui').eval() end";
        key = "<leader>de";
        mode = [
          "n"
          "v"
        ];
        options = {
          silent = true;
          noremap = true;
          desc = "Eval expression";
        };
      }

      # Go-specific
      {
        action = helpers.mkRaw "function() require('dap-go').debug_test() end";
        key = "<leader>dgt";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Debug Go test";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap-go').debug_last_test() end";
        key = "<leader>dgl";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Debug last Go test";
        };
      }

      # Python-specific
      {
        action = helpers.mkRaw "function() require('dap-python').test_method() end";
        key = "<leader>dpt";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Debug Python test method";
        };
      }
      {
        action = helpers.mkRaw "function() require('dap-python').test_class() end";
        key = "<leader>dpc";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Debug Python test class";
        };
      }

      # Rust-specific (via rustaceanvim)
      {
        action = "<cmd>RustLsp debuggables<CR>";
        key = "<leader>drt";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Debug Rust target";
        };
      }
      {
        action = "<cmd>RustLsp runnables<CR>";
        key = "<leader>drr";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Run Rust target";
        };
      }
    ];

    # Auto-open/close DAP UI with debug sessions
    extraConfigLua = ''
      local dap, dapui = require("dap"), require("dapui")
      dap.listeners.after.event_initialized["dapui_config"] = function()
        dapui.open()
      end
      dap.listeners.before.event_terminated["dapui_config"] = function()
        dapui.close()
      end
      dap.listeners.before.event_exited["dapui_config"] = function()
        dapui.close()
      end
    '';
  };
}
