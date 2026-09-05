{
  description = "SillyBunny development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # package.json engines: node >= 20, bun >= 1.3.14.
        # Bun is the primary runtime; Node parity is required for backend changes.
        nodejs = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pkgs.bun
          ];

          shellHook = ''
            echo "SillyBunny dev shell — node $(node --version), bun $(bun --version)"
            echo "Root deps:  npm install          (.npmrc pins ignore-scripts + min-release-age)"
            echo "Test deps:  npm install --prefix tests"
            echo "Start:      bun run start        (Node: npm run start:node)"
          '';
        };
      });
}
