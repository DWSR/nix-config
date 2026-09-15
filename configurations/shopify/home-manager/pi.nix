{
  inputs,
  pkgs,
  ...
}:
let
  piShopify = pkgs.callPackage ../../../scripts/pi-shopify.nix {
    pi = inputs.pi.packages.${pkgs.system}.coding-agent;
  };
  shopifyPiProxy = pkgs.callPackage ../../../scripts/shopify-pi-proxy.nix {
    src = ./extensions/shopify-pi-proxy;
  };
in
{
  programs.pi.coding-agent = {
    package = piShopify;
    extensions = [ "${shopifyPiProxy}/index.ts" ];
  };
}
