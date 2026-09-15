{
  pkgs,
  src,
}:
pkgs.runCommand "shopify-pi-proxy" { } ''
  mkdir -p "$out"
  cp -R ${src}/. "$out/"
  chmod -R a-w "$out"
''
