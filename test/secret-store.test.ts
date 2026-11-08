import { describe, expect, it } from "vitest";
import { type SecretAsker, type SecretStore, provideSecrets } from "../src/deploy/secret-store.ts";
import { declaredNames, secretNeeds } from "../src/deploy/secrets.ts";

/** A store that holds `names`, and records what is written to it. */
function store(names: string[] = [], fail?: Error) {
  const writes: Record<string, string>[] = [];
  const held = new Set(names);
  const fake: SecretStore = {
    async exists() {
      return true;
    },
    async ensure() {},
    async names() {
      if (fail) throw fail;
      return held;
    },
    async write(values) {
      writes.push({ ...values });
    },
  };
  return { fake, writes };
}

/** A person at a terminal, with scripted answers; every question asked is kept. */
function person(options: { confirm?: boolean; typed?: Record<string, string> } = {}) {
  const asked: string[] = [];
  const asker: SecretAsker = {
    async confirm(question) {
      asked.push(question);
      return options.confirm ?? true;
    },
    async secret(need) {
      asked.push(need.name);
      const value = options.typed?.[need.name];
      if (value === undefined) throw new Error(`nobody typed ${need.name}`);
      return value;
    },
  };
  return { asker, asked };
}

const need = (name: string, hint = `required by src/${name}.ts`) => ({ name, hint });
const commands = { push: "fastagent secrets push fly", set: (name: string) => `fastagent secrets set fly ${name}` };
const base = { host: "Fly", commands };

describe("provideSecrets: the target holds every name the deployment needs", () => {
  it("asks nothing and writes nothing when the target has them all", async () => {
    const { fake, writes } = store(["A", "B"]);
    const { asker, asked } = person();
    const out = await provideSecrets({
      ...base,
      store: fake,
      needs: [need("A"), need("B")],
      known: ["A", "B"],
      source: { file: ".secrets/production/.env", values: new Map([["A", "a"]]) },
      asker,
    });
    expect(out).toBeUndefined();
    expect(writes).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("offers the names a value file holds with ONE question, writes them in one batch, and asks only for the rest", async () => {
    const { fake, writes } = store(["C"]);
    const { asker, asked } = person({ typed: { B: "typed-b" } });
    const out = await provideSecrets({
      ...base,
      store: fake,
      needs: [need("A"), need("B"), need("C")],
      known: ["A", "B", "C", "OPT"],
      source: {
        file: ".secrets/production/.env",
        // OPT is declared and optional: offered along; UNDECLARED is held by the file and never offered; an empty
        // line is not a value.
        values: new Map([
          ["A", "file-a"],
          ["OPT", "file-opt"],
          ["UNDECLARED", "x"],
          ["B", ""],
        ]),
      },
      asker,
    });
    expect(out).toBeUndefined();
    expect(asked).toEqual([
      "Fly lacks A, OPT (optional), which .secrets/production/.env holds. Set them on Fly from it?",
      "B",
    ]);
    expect(writes).toEqual([{ A: "file-a", OPT: "file-opt", B: "typed-b" }]);
  });

  it("asks for each value when the person declines the file", async () => {
    const { fake, writes } = store();
    const { asker, asked } = person({ confirm: false, typed: { A: "typed-a" } });
    await provideSecrets({
      ...base,
      store: fake,
      needs: [need("A")],
      known: ["A"],
      source: { file: "f.env", values: new Map([["A", "file-a"]]) },
      asker,
    });
    expect(asked).toEqual(["Fly lacks A, which f.env holds. Set them on Fly from it?", "A"]);
    expect(writes).toEqual([{ A: "typed-a" }]);
  });

  it("with nobody to ask, stops naming each name, what it is for, and the commands, and writes nothing", async () => {
    const { fake, writes } = store();
    const out = await provideSecrets({
      ...base,
      store: fake,
      needs: [need("A"), need("B", "your model provider key")],
      known: ["A", "B"],
      source: { file: "f.env", values: new Map([["A", "file-a"]]) },
    });
    expect(out).toContain("Fly has no value for: A (required by src/A.ts); B (your model provider key).");
    expect(out).toContain("`fastagent secrets push fly` sets the one a value file holds (A)");
    expect(out).toContain("a person types the others in a terminal, one command each: `fastagent secrets set fly B`");
    // A CI job and a secret manager have their own way in.
    expect(out).toContain("`fastagent secrets push fly --from-env` takes them from the environment");
    expect(out).toContain("Then re-run. A value is never asked for in a conversation");
    expect(writes).toEqual([]);
  });

  it("with nobody to ask, says which names a file holds that the target lacks, and sets none of them", async () => {
    const { fake, writes } = store(["A"]);
    const said: string[] = [];
    const out = await provideSecrets({
      ...base,
      store: fake,
      needs: [need("A")],
      known: ["A", "OPT"],
      source: { file: "f.env", values: new Map([["OPT", "file-opt"]]) },
      say: (line) => said.push(line),
    });
    expect(out).toBeUndefined();
    expect(said).toEqual(["Fly lacks OPT, which f.env holds; `fastagent secrets push fly` sets it"]);
    expect(writes).toEqual([]);
  });

  it("one name nobody holds reads as a sentence about it, not about a plural", async () => {
    const { fake } = store();
    const out = await provideSecrets({ ...base, store: fake, needs: [need("A")], known: ["A"] });
    expect(out).toContain("a person types it in a terminal, one command each: `fastagent secrets set fly A`");
  });

  it("a target that cannot be read is a gate saying why, never an empty target to fill", async () => {
    const { fake, writes } = store([], new Error("`fly secrets list` failed"));
    const { asker } = person({ typed: { A: "a" } });
    const out = await provideSecrets({ ...base, store: fake, needs: [need("A")], known: ["A"], asker });
    expect(out).toBe("Fly's values could not be read or set: `fly secrets list` failed");
    expect(writes).toEqual([]);
  });

  it("a person who walks away stops the deploy with that, and nothing is half written", async () => {
    const { fake, writes } = store();
    const { asker } = person({ typed: { A: "a" } }); // B has no answer: the prompt throws
    const out = await provideSecrets({ ...base, store: fake, needs: [need("A"), need("B")], known: ["A", "B"], asker });
    expect(out).toContain("nobody typed B");
    expect(writes).toEqual([]);
  });
});

describe("provideSecrets: values FastAgent makes itself", () => {
  const mint = [{ name: "KEY", make: () => "made" }];

  it("makes one only where neither the target nor the file has it, and keeps it where its caller looks", async () => {
    const { fake, writes } = store();
    const kept: Record<string, string>[] = [];
    await provideSecrets({
      ...base,
      store: fake,
      needs: [],
      known: ["KEY"],
      asker: person().asker,
      mint,
      onMinted: async (values) => void kept.push(values),
    });
    expect(writes).toEqual([{ KEY: "made" }]);
    expect(kept).toEqual([{ KEY: "made" }]);
  });

  it("a target that lacks a key the file holds gets that one, with nobody to ask: a new key would strand its callers", async () => {
    // A deployment made again (the app was destroyed, the file kept): leaving the key unset serves no Agent API at all.
    const { fake, writes } = store();
    const kept: Record<string, string>[] = [];
    const told: string[] = [];
    const left: string[] = [];
    await provideSecrets({
      ...base,
      store: fake,
      needs: [],
      known: ["KEY"],
      source: { file: "f.env", values: new Map([["KEY", "from-file"]]) },
      mint,
      onMinted: async (values) => void kept.push(values),
      inform: (line) => told.push(line),
      say: (line) => left.push(line),
    });
    expect(writes).toEqual([{ KEY: "from-file" }]);
    expect(kept).toEqual([]); // nothing new to record: the file already has it
    expect(told).toEqual(["set KEY on Fly from f.env, where an earlier deploy kept it"]);
    expect(left).toEqual([]); // nothing for the person to do
  });

  it("makes none when the target holds one; one the file holds is set without a question", async () => {
    const held = store(["KEY"]);
    await provideSecrets({ ...base, store: held.fake, needs: [], known: ["KEY"], asker: person().asker, mint });
    expect(held.writes).toEqual([]);

    const filed = store();
    const { asker, asked } = person();
    await provideSecrets({
      ...base,
      store: filed.fake,
      needs: [],
      known: ["KEY"],
      source: { file: "f.env", values: new Map([["KEY", "from-file"]]) },
      asker,
      mint,
    });
    expect(filed.writes).toEqual([{ KEY: "from-file" }]);
    expect(asked).toEqual([]);
  });

  it("needs no one to ask: a coding agent's deploy mints it too, and still names a name it cannot", async () => {
    const { fake, writes } = store();
    expect(await provideSecrets({ ...base, store: fake, needs: [], known: ["KEY"], mint })).toBeUndefined();
    expect(writes).toEqual([{ KEY: "made" }]);

    const lacking = store();
    const out = await provideSecrets({ ...base, store: lacking.fake, needs: [need("A")], known: ["A", "KEY"], mint });
    expect(out).toContain("A (required by src/A.ts)");
    expect(lacking.writes).toEqual([]);
  });
});

describe("secretNeeds and declaredNames", () => {
  const declared = [
    { name: "GH_TOKEN", declaredIn: "tools/gh.ts", optional: false },
    { name: "SENTRY_DSN", declaredIn: "tools/report.ts", optional: true },
  ];

  it("needs the declared names that are not optional, hinted by their file, and offers the optional ones too", () => {
    expect(secretNeeds(undefined, declared)).toEqual([{ name: "GH_TOKEN", hint: "required by tools/gh.ts" }]);
    expect(declaredNames(undefined, declared)).toEqual(["GH_TOKEN", "SENTRY_DSN"]);
  });

  it("needs the model's key when the value file holds one, or when the provider has no login to run on the box", () => {
    expect(secretNeeds("OPENAI_API_KEY", [])).toEqual([{ name: "OPENAI_API_KEY", hint: "your model provider key" }]);
    const noLogin = { variables: ["GROQ_API_KEY", "GROQ_KEY"], required: true };
    expect(secretNeeds(undefined, [], noLogin)).toEqual([
      { name: "GROQ_API_KEY", hint: "your model provider key: it has no login to run on the box" },
    ]);
    // With a login to fall back on, the key is only something a source may supply.
    const withLogin = { variables: ["OPENAI_API_KEY"], required: false };
    expect(secretNeeds(undefined, [], withLogin)).toEqual([]);
    expect(declaredNames(undefined, declared, withLogin)).toEqual(["OPENAI_API_KEY", "GH_TOKEN", "SENTRY_DSN"]);
  });

  it("a name some declaration requires is required, whatever another says, and listed once", () => {
    const twice = [
      { name: "X", declaredIn: "a.ts", optional: true },
      { name: "X", declaredIn: "b.ts", optional: false },
    ];
    expect(secretNeeds(undefined, twice)).toEqual([{ name: "X", hint: "required by b.ts" }]);
    expect(declaredNames(undefined, twice)).toEqual(["X"]);
  });
});
