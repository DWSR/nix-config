local bundlePath = "/Applications/Deskflow.app"
local guiExecutablePath = bundlePath .. "/Contents/MacOS/Deskflow"
local coreExecutablePath = bundlePath .. "/Contents/MacOS/deskflow-core"

return {
	constants = {
		bundlePath = bundlePath,
		guiExecutablePath = guiExecutablePath,
		coreExecutablePath = coreExecutablePath,
	},
	process = {
		healthyClient = {
			name = "one GUI-owned client core is healthy",
			expectedClassification = "healthy",
			expectedRole = "client",
			snapshot = "4101\t4100\t" .. coreExecutablePath .. "\tclient\n",
			guiRecords = {
				{ pid = 4100, bundlePath = bundlePath },
			},
		},
		healthyServer = {
			name = "one GUI-owned server core is healthy",
			expectedClassification = "healthy",
			expectedRole = "server",
			snapshot = "4201\t4200\t" .. coreExecutablePath .. "\tserver\n",
			guiRecords = {
				{ pid = 4200, bundlePath = bundlePath },
			},
		},
		absent = {
			name = "expected GUI is present without a core",
			expectedClassification = "absent",
			expectedRole = "server",
			snapshot = "",
			guiRecords = {
				{ pid = 4300, bundlePath = bundlePath },
			},
		},
		orphan = {
			name = "expected-path server core has no Deskflow GUI parent",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4401\t1\t" .. coreExecutablePath .. "\tserver\n",
			guiRecords = {},
		},
		wrongCorePath = {
			name = "same-named server core runs from an unrelated path",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4501\t4500\t/opt/deskflow-test/deskflow-core\tserver\n",
			guiRecords = {
				{ pid = 4500, bundlePath = bundlePath },
			},
		},
		wrongGuiPath = {
			name = "bundle-ID GUI runs outside the expected application path",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4601\t4600\t" .. coreExecutablePath .. "\tserver\n",
			guiRecords = {
				{ pid = 4600, bundlePath = "/Applications/Deskflow Preview.app" },
			},
		},
		wrongRole = {
			name = "GUI-owned core runs in the client role instead of server",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4701\t4700\t" .. coreExecutablePath .. "\tclient\n",
			guiRecords = {
				{ pid = 4700, bundlePath = bundlePath },
			},
		},
		duplicateGui = {
			name = "multiple expected-path GUI instances make ownership ambiguous",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4801\t4800\t" .. coreExecutablePath .. "\tserver\n",
			guiRecords = {
				{ pid = 4800, bundlePath = bundlePath },
				{ pid = 4802, bundlePath = bundlePath },
			},
		},
		duplicateCore = {
			name = "multiple GUI-owned server cores make ownership ambiguous",
			expectedClassification = "ambiguous",
			expectedRole = "server",
			snapshot = "4901\t4900\t"
				.. coreExecutablePath
				.. "\tserver\n4902\t4900\t"
				.. coreExecutablePath
				.. "\tserver\n",
			guiRecords = {
				{ pid = 4900, bundlePath = bundlePath },
			},
		},
	},
	menus = {
		serverStart = {
			name = "German server menu selects one enabled Command-S action",
			expectedMenuOutcome = "selected",
			expectedPath = { "Datei", "Starten" },
			tree = {
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Deskflow",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Uber Deskflow",
							AXEnabled = true,
							AXMenuItemCmdChar = "",
						},
					},
				},
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Datei",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Starten",
							AXEnabled = true,
							AXMenuItemCmdChar = "S",
							AXMenuItemCmdModifiers = { "cmd" },
						},
						{
							AXRole = "AXMenuItem",
							AXTitle = "Beenden",
							AXEnabled = true,
							AXMenuItemCmdChar = "Q",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
		clientStartLocalized = {
			name = "French client menu selects one enabled lowercase Command-S action",
			expectedMenuOutcome = "selected",
			expectedPath = { "Fichier", "Se connecter" },
			tree = {
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Fichier",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Se connecter",
							AXEnabled = true,
							AXMenuItemCmdChar = "s",
							AXMenuItemCmdModifiers = { "cmd" },
						},
						{
							AXRole = "AXMenuItem",
							AXTitle = "Quitter",
							AXEnabled = true,
							AXMenuItemCmdChar = "Q",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
		disabledOnly = {
			name = "localized Command-S action exists but is disabled",
			expectedMenuOutcome = "disabled-only",
			tree = {
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Fichier",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Se connecter",
							AXEnabled = false,
							AXMenuItemCmdChar = "S",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
		zeroCandidates = {
			name = "localized menu has no exact enabled Command-S candidate",
			expectedMenuOutcome = "zero-candidates",
			tree = {
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Fichier",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Enregistrer sous",
							AXEnabled = true,
							AXMenuItemCmdChar = "S",
							AXMenuItemCmdModifiers = { "cmd", "shift" },
						},
						{
							AXRole = "AXMenuItem",
							AXTitle = "Recharger",
							AXEnabled = true,
							AXMenuItemCmdChar = "R",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
		multipleCandidates = {
			name = "localized menu has multiple enabled Command-S candidates",
			expectedMenuOutcome = "multiple-candidates",
			tree = {
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Datei",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Starten",
							AXEnabled = true,
							AXMenuItemCmdChar = "S",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
				{
					AXRole = "AXMenuBarItem",
					AXTitle = "Fenster",
					AXChildren = {
						{
							AXRole = "AXMenuItem",
							AXTitle = "Seitenleiste",
							AXEnabled = true,
							AXMenuItemCmdChar = "s",
							AXMenuItemCmdModifiers = { "cmd" },
						},
					},
				},
			},
		},
	},
}
