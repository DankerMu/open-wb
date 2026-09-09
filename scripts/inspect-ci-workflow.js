#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const FALLBACK = "ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION";
const ALLOWED = {
  "actions/checkout": "v5",
  "actions/setup-node": "v5",
  "astral-sh/setup-uv": "v7",
  "gitleaks/gitleaks-action": "v3",
};
const WANT = {
  "actions/checkout@v5": 7,
  "actions/setup-node@v5": 5,
  "astral-sh/setup-uv@v7": 2,
  "gitleaks/gitleaks-action@v3": 1,
};
const CORE_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
]);

function fail(reason) {
  if (reason) process.stderr.write(`${reason}\n`);
  process.exit(1);
}

function readWorkflow(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    fail(`cannot read ${file}`);
  }
}

function parseWorkflow(text) {
  const doc = YAML.parseDocument(text, {
    merge: false,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (doc.errors.length > 0 || doc.warnings.length > 0) fail("yaml parse error");
  YAML.visit(doc, {
    Alias() {
      fail("alias");
    },
    Node(_, node) {
      if (node?.tag && !CORE_TAGS.has(node.tag)) fail("custom tag");
    },
    Pair(_, pair) {
      if (YAML.isScalar(pair.key) && pair.key.value === "<<") fail("merge");
    },
  });
  return doc;
}

function mapping(node, label) {
  if (!YAML.isMap(node)) fail(`${label} is not a mapping`);
  return node;
}

function keyName(node) {
  if (!YAML.isScalar(node) || typeof node.value !== "string") fail("non-string key");
  return node.value;
}

function inspectEnv(node, label) {
  for (const pair of mapping(node, label).items) {
    if (keyName(pair.key) === FALLBACK) fail("fallback env");
  }
}

function inspectUses(node) {
  if (node == null || (YAML.isScalar(node) && node.value == null)) fail("missing uses");
  if (!YAML.isScalar(node) || typeof node.value !== "string") fail("non-string uses");
  const used = node.value;
  if (used.startsWith("./") || used.startsWith("docker://")) return null;
  const parts = used.split("@");
  const family = parts[0];
  if (!(family in ALLOWED)) return null;
  if (parts.length !== 2) fail("protected uses without unique ref");
  if (parts[1] !== ALLOWED[family]) fail("unapproved protected ref");
  return used;
}

function inspectStep(node) {
  let used = null;
  for (const pair of mapping(node, "step").items) {
    const name = keyName(pair.key);
    if (name === "uses") used = inspectUses(pair.value);
    if (name === "env") inspectEnv(pair.value, "step env");
  }
  return used;
}

function inspectSteps(node) {
  if (!YAML.isSeq(node)) fail("steps is not a sequence");
  const found = [];
  for (const item of node.items) {
    const used = inspectStep(item);
    if (used) found.push(used);
  }
  return found;
}

function inspectJob(node) {
  const found = [];
  for (const pair of mapping(node, "job").items) {
    const name = keyName(pair.key);
    if (name === "env") inspectEnv(pair.value, "job env");
    if (name === "steps") found.push(...inspectSteps(pair.value));
  }
  return found;
}

function sameCounts(counts) {
  const expected = Object.keys(WANT);
  if (Object.keys(counts).length !== expected.length) fail("protected cardinality");
  for (const key of expected) {
    if (counts[key] !== WANT[key]) fail("protected cardinality");
  }
}

function inspectWorkflow(doc) {
  const root = mapping(doc.contents, "workflow");
  let jobs;
  for (const pair of root.items) {
    const name = keyName(pair.key);
    if (name === "env") fail("workflow env");
    if (name === "jobs") jobs = mapping(pair.value, "jobs");
  }
  if (!jobs) fail("missing jobs");
  const counts = {};
  for (const pair of jobs.items) {
    keyName(pair.key);
    for (const used of inspectJob(pair.value)) counts[used] = (counts[used] || 0) + 1;
  }
  sameCounts(counts);
}

function main(argv) {
  if (argv.length !== 3 || !argv[2]) fail("usage: inspect-ci-workflow.js <workflow>");
  inspectWorkflow(parseWorkflow(readWorkflow(path.resolve(argv[2]))));
}

main(process.argv);
