#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const PACKAGE_NAME = "@fastagent-sh/fastagent";
// Every package of the workspace, in the order they build and publish; all share one version.
const WORKSPACES = [
	"packages/client",
	"packages/client-agentcore",
	"packages/fastagent",
	"packages/agentcore",
	"packages/pi-remote",
	"packages/harness-dsh",
];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function usage() {
	console.log(`Usage: node scripts/release.mjs <major|minor|patch|x.y.z> [--yes]

Creates a verified release pull request. It does not merge, tag, create a GitHub
Release, or publish to npm.

Options:
  --yes  Skip the confirmation prompt`);
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
		shell: process.platform === "win32",
	});

	if (result.error) throw result.error;
	if (result.status !== 0 && !options.allowFailure) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}
	return result;
}

function capture(command, args) {
	return run(command, args, { capture: true }).stdout.trim();
}

function readPackage(dir) {
	return JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
}

/** Find every `package.json` under `examples/` (excluding `node_modules` and `dist`). */
function exampleManifests(dir = "examples") {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...exampleManifests(full));
		else if (entry.isFile() && entry.name === "package.json") found.push(full);
	}
	return found.sort();
}

/**
 * Give every workspace package `version`, pin intra-workspace references to `version`, and bump every example's
 * `@fastagent-sh/*` dependency range to `^${version}`. Returns the updated example manifest paths.
 */
function setVersion(version) {
	const names = new Set(WORKSPACES.map((dir) => readPackage(dir).name));
	for (const dir of WORKSPACES) {
		const pkg = readPackage(dir);
		pkg.version = version;
		for (const field of ["dependencies", "peerDependencies"]) {
			for (const name of Object.keys(pkg[field] ?? {})) if (names.has(name)) pkg[field][name] = version;
		}
		writeFileSync(`${dir}/package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
	}
	const updatedExamples = [];
	for (const manifest of exampleManifests()) {
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		let changed = false;
		for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
			for (const name of Object.keys(pkg[field] ?? {})) {
				if (names.has(name) && pkg[field][name] !== `^${version}`) {
					pkg[field][name] = `^${version}`;
					changed = true;
				}
			}
		}
		if (changed) {
			writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
			updatedExamples.push(manifest);
		}
	}
	run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
	return updatedExamples;
}

function compareVersions(a, b) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function nextVersion(current, target) {
	if (SEMVER_RE.test(target)) {
		if (compareVersions(target, current) <= 0) throw new Error(`Target version ${target} must be greater than current version ${current}.`);
		return target;
	}

	const [major, minor, patch] = current.split(".").map(Number);
	if (target === "major") return `${major + 1}.0.0`;
	if (target === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function assertAvailable(command, args, message) {
	const result = run(command, args, { allowFailure: true, capture: true });
	if (result.status !== 0) throw new Error(message);
}

function assertNpmVersionIsUnpublished(name, version) {
	const result = run("npm", ["view", `${name}@${version}`, "version", "--json"], { allowFailure: true, capture: true });
	if (result.status === 0 && result.stdout.trim()) throw new Error(`${name}@${version} is already published.`);
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (!output.includes("E404") && !output.includes("404 Not Found")) {
		throw new Error(`Could not verify that ${name}@${version} is unpublished.\n${output.trim()}`);
	}
}

async function confirm(version) {
	if (process.argv.includes("--yes")) return true;
	if (!process.stdin.isTTY) throw new Error("Confirmation requires an interactive terminal; pass --yes to continue non-interactively.");
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await prompt.question(`Create a release PR for v${version}? [y/N] `);
		return /^y(?:es)?$/i.test(answer.trim());
	} finally {
		prompt.close();
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		usage();
		return;
	}
	const unknown = args.filter((arg) => arg !== "--yes" && arg !== args[0]);
	const target = args[0];
	if (!target || unknown.length > 0 || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
		usage();
		throw new Error("Expected one release target: major, minor, patch, or x.y.z.");
	}

	const pkg = readPackage("packages/fastagent");
	if (pkg.name !== PACKAGE_NAME) throw new Error(`Run this script from the ${PACKAGE_NAME} repository root.`);
	for (const dir of WORKSPACES) {
		const other = readPackage(dir);
		if (other.version !== pkg.version) throw new Error(`${other.name} is at ${other.version}, not ${pkg.version}: every package shares one version.`);
	}
	if (!SEMVER_RE.test(pkg.version)) throw new Error(`Current package version is not a stable semantic version: ${pkg.version}`);
	if (capture("git", ["branch", "--show-current"]) !== "main") throw new Error("Releases must start from the main branch.");
	if (capture("git", ["status", "--porcelain"])) throw new Error("Working tree is not clean. Commit or stash changes first.");

	assertAvailable("gh", ["auth", "status"], "GitHub CLI is unavailable or not authenticated. Run `gh auth login` first.");
	run("git", ["fetch", "origin", "main", "--tags"]);
	if (capture("git", ["rev-parse", "HEAD"]) !== capture("git", ["rev-parse", "origin/main"])) {
		throw new Error("Local main is not identical to origin/main. Run `git pull --ff-only` first.");
	}

	const version = nextVersion(pkg.version, target);
	const tag = `v${version}`;
	const branch = `chore/release-${version}`;
	const existingBranch = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true, capture: true });
	if (existingBranch.status === 0) throw new Error(`Local branch already exists: ${branch}`);
	if (capture("git", ["ls-remote", "--heads", "origin", branch])) throw new Error(`Remote branch already exists: ${branch}`);
	const existingTag = run("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { allowFailure: true, capture: true });
	if (existingTag.status === 0 || capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])) throw new Error(`Tag already exists: ${tag}`);
	for (const dir of WORKSPACES) {
		const member = readPackage(dir);
		if (!member.private) assertNpmVersionIsUnpublished(member.name, version);
	}

	console.log(`\nCurrent version: ${pkg.version}\nTarget version:  ${version}\nBranch:          ${branch}\n`);
	if (!(await confirm(version))) {
		console.log("Release cancelled.");
		return;
	}

	run("git", ["checkout", "-b", branch]);
	const updatedExamples = setVersion(version);
	run("npm", ["run", "lint"]);
	run("npm", ["run", "typecheck"]);
	run("npm", ["audit", "--audit-level=high"]);
	run("npm", ["test"]);
	run("npm", ["run", "test:integration"]);
	run("npm", ["pack", "--dry-run", "--json", "--workspaces"]);

	run("git", ["add", ...WORKSPACES.map((dir) => `${dir}/package.json`), ...updatedExamples, "package-lock.json"]);
	run("git", ["commit", "-m", `chore: release ${version}`]);
	run("git", ["push", "-u", "origin", branch]);
	const body = `## Release v${version}\n\nBump every package (${WORKSPACES.join(", ")}) from ${pkg.version} to ${version}.\n\n### Verification\n\n- \`npm run lint\`\n- \`npm run typecheck\`\n- \`npm audit --audit-level=high\`\n- \`npm test\`\n- \`npm run test:integration\`\n- \`npm pack --dry-run --json --workspaces\`\n\n### After merge\n\nCreate and publish the GitHub Release \`${tag}\`. The protected publish workflow will verify and publish the packages to npm via Trusted Publishing.`;
	const pr = capture("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore: release ${version}`, "--body", body]);

	console.log(`\nRelease PR created: ${pr}`);
	console.log(`After a maintainer merges it, create and publish GitHub Release ${tag}.`);
	console.log(`The release branch remains checked out at ${branch}.`);
}

main().catch((error) => {
	console.error(`\nRelease failed: ${error instanceof Error ? error.message : error}`);
	process.exitCode = 1;
});
