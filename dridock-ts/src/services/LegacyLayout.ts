/**
 * The refusal for a project still on `.claudebox/` (#135). Used by main.ts's guard; its own module so tests can import it.
 * What the four removed migrators did, as the steps a person can take.
 *
 * It carries the two #32 guards the migrators enforced in code (Arfy, #135
 * review), since the steps are now the only place they can live:
 *   A: cdp/ holds a running Chrome debug profile, and moving it under that
 *      Chrome corrupts the profile (SingletonLock). Stop the bridge first.
 *   B: when the destination exists, `mv` either refuses ("Directory not
 *      empty") or silently replaces an empty dir, so the steps say what to
 *      do: move entries, keep both on a collision, and never merge cdp/
 *      (half a Chrome profile is worse than either one).
 */
export function legacyLayoutRefusal(root: string, home: string): string[] {
  return [
    `❌ ${root} still uses the legacy .claudebox/ layout, which dridock 6.0 can't read or convert.\n`,
    `   Convert it by hand:\n`,
    `     mv '${root}/.claudebox' '${root}/.dridock'\n`,
    `     and change any /.claudebox/ lines in ${root}/.gitignore to /.dridock/\n`,
    `   If ${home}/.config/claudebox/ still exists, move what's in it under ${home}/.config/dridock/\n`,
    `   (config.yml, projects/, cdp/, consult/, framework-bugs/, host-agent/).\n`,
    `     Before moving cdp/, stop the debug Chrome (on the Mac: dridock browser-bridge down);\n`,
    `     moving a running Chrome's profile corrupts it.\n`,
    `     If the destination already exists, move the entries one by one and keep both copies\n`,
    `     on a clash (rename the old one with a .legacy suffix); never overwrite. cdp/ is the\n`,
    `     exception: keep ONE whole Chrome profile, never merge two.\n`,
    `   Or run 'dridock migrate' with a dridock 5.x install, which still has it.\n`,
    `   See docs/design/3.0-migration.md.\n`,
  ];
}
