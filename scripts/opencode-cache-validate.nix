{
  python3,
  writeShellApplication,
}:
writeShellApplication {
  name = "opencode-cache-validate";
  runtimeInputs = [ python3 ];
  text = ''
    exec ${python3}/bin/python3 -B ${./opencode-cache-validate.py} "$@"
  '';
}
