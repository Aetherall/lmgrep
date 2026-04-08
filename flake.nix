{
  description = "lmgrep – Semantic code search with any AI embedding provider";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_20;
        pnpm = pkgs.pnpm_10;

        src = pkgs.lib.cleanSource ./.;

        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "lmgrep";
          version = "0.1.0";
          inherit src;
          hash = "sha256-OqAkg9oCNBdMeG9P7Vz/xEunEd0AoDFFV50IxHz8jXI=";
          fetcherVersion = 3;
        };

        commonBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
        ];

        lmgrep = pkgs.stdenv.mkDerivation {
          pname = "lmgrep";
          version = "0.1.0";
          inherit src pnpmDeps;

          nativeBuildInputs = commonBuildInputs ++ [
            pkgs.installShellFiles
          ];

          env.CI = "true";

          buildPhase = ''
            runHook preBuild
            pnpm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/lmgrep $out/bin
            cp -r dist completions node_modules package.json $out/lib/lmgrep/
            # Symlink node as "lmgrep" so the process name shows correctly in monitors
            ln -s ${nodejs}/bin/node $out/lib/lmgrep/lmgrep
            cat > $out/bin/lmgrep <<WRAPPER
            #!${pkgs.bash}/bin/bash
            exec $out/lib/lmgrep/lmgrep $out/lib/lmgrep/dist/cli.js "\$@"
            WRAPPER
            chmod +x $out/bin/lmgrep

            # Install zsh completions
            installShellCompletion --zsh completions/_lmgrep

            runHook postInstall
          '';
        };

        lmgrep-mcp = pkgs.stdenv.mkDerivation {
          pname = "lmgrep-mcp";
          version = "0.1.0";
          inherit src pnpmDeps;

          nativeBuildInputs = commonBuildInputs;

          env.CI = "true";

          buildPhase = ''
            runHook preBuild
            pnpm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/lmgrep $out/bin
            cp -r dist node_modules package.json $out/lib/lmgrep/
            ln -s ${nodejs}/bin/node $out/lib/lmgrep/lmgrep-mcp
            cat > $out/bin/lmgrep-mcp <<WRAPPER
            #!${pkgs.bash}/bin/bash
            exec $out/lib/lmgrep/lmgrep-mcp $out/lib/lmgrep/dist/mcp.js "\$@"
            WRAPPER
            chmod +x $out/bin/lmgrep-mcp
            runHook postInstall
          '';
        };
      in
      {
        packages = {
          inherit lmgrep lmgrep-mcp;
          default = lmgrep;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ nodejs pnpm ];
        };
      }
    );
}
