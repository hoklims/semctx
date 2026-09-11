import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEMO_FILES = ["index.html", "app.js", "styles.css", "favicon.svg", "evidence.json"] as const;

export interface PagesArtifactOptions {
  repositoryRoot?: string;
  outputDirectory?: string;
}

function requireRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

function validateTree(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  if (!lstatSync(path).isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) validateTree(child, label);
    else if (!entry.isFile()) throw new Error(`${label} contains an unsupported entry: ${child}`);
  }
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
    else copyFileSync(sourcePath, destinationPath);
  }
}

export function buildPagesArtifact(options: PagesArtifactOptions = {}): string {
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const outputDirectory = resolve(repositoryRoot, options.outputDirectory ?? "_site");
  const landing = resolve(repositoryRoot, "site/landing/index.html");
  const fixtures = resolve(repositoryRoot, "site/fixtures");
  const demoFiles = DEMO_FILES.map((file) => ({ file, source: resolve(repositoryRoot, "site", file) }));

  requireRegularFile(landing, "Pages landing input");
  for (const item of demoFiles) requireRegularFile(item.source, `Pages demo input ${item.file}`);
  validateTree(fixtures, "Pages demo fixtures");
  if (existsSync(outputDirectory)) {
    throw new Error(`Pages output already exists; refusing to overwrite stale content: ${outputDirectory}`);
  }

  const outputParent = dirname(outputDirectory);
  mkdirSync(outputParent, { recursive: true });
  const stagingDirectory = mkdtempSync(join(outputParent, `.${basename(outputDirectory)}-staging-`));
  try {
    copyFileSync(landing, join(stagingDirectory, "index.html"));
    const demoDirectory = join(stagingDirectory, "demo");
    mkdirSync(demoDirectory);
    for (const item of demoFiles) copyFileSync(item.source, join(demoDirectory, item.file));
    copyTree(fixtures, join(demoDirectory, "fixtures"));
    renameSync(stagingDirectory, outputDirectory);
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  return outputDirectory;
}

if (import.meta.main) {
  try {
    const unexpected = process.argv.slice(2);
    if (unexpected.length > 0) throw new Error(`unexpected argument: ${unexpected[0]}`);
    console.log(`PAGES_ARTIFACT_READY ${buildPagesArtifact()}`);
  } catch (error) {
    console.error(`Pages artifact build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
