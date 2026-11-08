/** The checks of a script CI's Bun job runs: each prints one line, and `finish` exits non-zero when any failed. */
const failures: string[] = [];

export function check(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures.push(label);
}

export function finish(): never {
  if (failures.length > 0) {
    console.error(`${failures.length} failed on Bun ${process.versions.bun}: ${failures.join("; ")}`);
    process.exit(1);
  }
  process.exit(0);
}
