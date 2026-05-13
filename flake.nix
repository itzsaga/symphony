# Symphony v1 dev shell
# Provides bun, nono (sandbox), claude (>= 2.0.0), git, jq, yq-go via `nix develop`.
{
  description = "Symphony v1 dev shell — bun, nono, claude, plus standard build tools.";

  inputs = {
    # Pinned to an explicit nixos-unstable revision (2026-05-10) so the dev
    # shell is byte-reproducible across machines. Bumped via `nix flake update`.
    nixpkgs.url = "github:NixOS/nixpkgs/da5ad661ba4e5ef59ba743f0d112cbc30e474f32";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachSystem
      [
        "aarch64-darwin"
        "x86_64-linux"
      ]
      (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            # claude-code ships under Anthropic's Commercial Terms of Service,
            # which nixpkgs flags as `unfree`. Allow it (and only it) so the
            # dev shell evaluates without requiring NIXPKGS_ALLOW_UNFREE=1.
            config.allowUnfreePredicate =
              pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "claude-code" ];
          };
        in
        {
          devShells.default = pkgs.mkShell {
            name = "symphony-devshell";

            # Build inputs at a glance:
            #   bun         — JS/TS runtime + package manager (Symphony is a Bun project).
            #   nono        — kernel-enforced sandbox CLI used to wrap every `claude` invocation.
            #   claude-code — the Claude Code CLI (>= 2.0.0); stream-json transport requires this.
            #   git, jq     — standard tools used by hooks and the orchestrator.
            #   yq-go       — mikefarah's Go yq v4 (NOT the Python jq-wrapper); used to read
            #                 workflow YAML configs from shell scripts.
            packages = [
              pkgs.bun
              pkgs.nono
              pkgs.claude-code
              pkgs.git
              pkgs.jq
              pkgs.yq-go
            ];
          };
        }
      );
}
