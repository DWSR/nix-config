{ pkgs }:
pkgs.writeShellApplication {
  name = "bump-shopify-taps";
  runtimeInputs = with pkgs; [
    gh
    gnused
    nixfmt
    git
  ];
  text = ''
    TARGET="configurations/shopify/default.nix"

    if [ ! -f "$TARGET" ]; then
      echo "Error: $TARGET not found. Run this from the repository root." >&2
      exit 1
    fi

    changed=false

    while IFS=: read -r repo branch; do
      new_rev=$(gh api "repos/$repo/commits/$branch" --jq '.sha')
      old_rev=$(grep -A2 "$repo" "$TARGET" | grep 'rev =' | sed 's/.*"\(.*\)".*/\1/')

      if [ "$old_rev" = "$new_rev" ]; then
        echo "$repo: already up to date (''${old_rev:0:12})"
      else
        sed -i "s/$old_rev/$new_rev/" "$TARGET"
        echo "$repo: ''${old_rev:0:12} -> ''${new_rev:0:12}"
        changed=true
      fi
    done <<EOF
    Shopify/homebrew-shopify:master
    Shopify/homebrew-private:main
    EOF

    nixfmt "$TARGET"

    if [ "$changed" = true ]; then
      git add "$TARGET"
      git commit -m "chore: bump shopify homebrew taps"
      echo "Committed changes."
    else
      echo "No changes to commit."
    fi
  '';
}
