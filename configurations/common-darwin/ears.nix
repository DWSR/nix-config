{ username, ... }:
{
  # Ears Insta-Mute shortcut (Fn+F12) — stored as an NSKeyedArchive
  # that can't be set via CustomUserPreferences.
  system.activationScripts.earsShortcut.text = ''
    sudo -u ${username} defaults write com.clickontyler.Ears kInstaMuteShortcut -data 62706c6973743030d4010203040506070a582476657273696f6e592461726368697665725424746f7058246f626a6563747312000186a05f100f4e534b657965644172636869766572d1080954726f6f748001a30b0c1355246e756c6cd30d0e0f101112574b6579436f64655624636c6173735d4d6f646966696572466c616773106f80021200160000d2141516175a24636c6173736e616d655824636c61737365735b4d415353686f7274637574a218195b4d415353686f7274637574584e534f626a65637408111a24293237494c5153575d646c738183858a8f9aa3afb2be0000000000000101000000000000001a000000000000000000000000000000c7
  '';

  system.defaults.CustomUserPreferences."com.clickontyler.Ears" = {
    SUEnableAutomaticChecks = true;
    SUSendProfileInfo = false;
    instaMuteBezel = true;
    kDockAction = 0;
    kDockMenuBar = true;
    launchOnBoot = true;
    showHotMic = true;
  };
}
