/**
 * The refusal for a project still on `.claudebox/` (#135). Used by main.ts's guard; its own module so tests can import it.
 * What the four removed migrators did, as the steps a person can take.
 */
export function legacyLayoutRefusal(root: string, home: string): string[] {
  return [
    `❌ ${root} still uses the legacy .claudebox/ layout, which dridock 6.0 can't read or convert.\n`,
    `   Convert it by hand:\n`,
    `     mv '${root}/.claudebox' '${root}/.dridock'\n`,
    `     and change any /.claudebox/ lines in ${root}/.gitignore to /.dridock/\n`,
    `   If ${home}/.config/claudebox/ still exists, move what's in it under ${home}/.config/dridock/\n`,
    `   (config.yml, projects/, cdp/, consult/, framework-bugs/, host-agent/).\n`,
    `   Or run 'dridock migrate' with a dridock 5.x install, which still has it.\n`,
    `   See docs/design/3.0-migration.md.\n`,
  ];
}
