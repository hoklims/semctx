import { createHash } from "node:crypto";
import { posix } from "node:path";

const canonical = value => JSON.stringify(value, (_key, field) => field && !Array.isArray(field) && typeof field === "object" ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : field);
export const publicDigest = value => "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");

export function validatePublicUnits(input) {
  if (!Array.isArray(input?.units) || input.units.length === 0) throw new Error("PUBLIC_PROOF_INPUT_INVALID: empty units");
  const ids = new Set();
  for (const unit of input.units) {
    if (!unit || typeof unit.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(unit.id) || ids.has(unit.id)) throw new Error("PUBLIC_PROOF_INPUT_INVALID: duplicate or invalid unit id");
    ids.add(unit.id);
  }
}

export function rawContextChecks(observed, request, sdk) {
  const key = path => {
    const normalized = posix.normalize(path.replaceAll("\\", "/"));
    if (!normalized.startsWith("/")) throw new Error("PUBLIC_PROOF_INPUT_INVALID: absolute input path required");
    return request.case_sensitive ? normalized : normalized.toLowerCase();
  };
  const location = (root, path, domain) => {
    root = key(root);
    path = key(path);
    return path === root ? { domain, path: "" } : path.startsWith(root + "/") ? { domain, path: path.slice(root.length + 1) } : { domain: "external", path };
  };
  const project = Object.entries(request.files).map(([path, text]) => ({ location: location(request.cwd, path, "repository"), representation: "text", text })).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  const files = Object.entries(sdk.files).map(([path, text]) => ({ location: location(request.sdk_directory, path, "sdk"), text })).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  const logical = { domain: "T00-logical-input-v2", project, sdk: { domain: "T00-logical-sdk-v2", version: sdk.version, archive_sha256: sdk.archive_sha256, files } };
  return {
    supportedInputRepresentations: Object.keys(request.raw_files).length === 0 && Object.keys(request.utf16_files).length === 0,
    requestIdentity: observed.request === request.id && observed.request_id === publicDigest(request),
    inputAndSdkIdentity: observed.input_manifest_id === publicDigest(logical) && observed.sdk_version === sdk.version,
    complete: observed.complete === true,
    noAdmission: observed.global_admission_inferred === false,
    productContext: request.roots.every(root => {
      const path = posix.relative(request.cwd, root);
      const matches = observed.subjects?.filter(subject => subject.path === path) ?? [];
      return matches.length === 1 && ["analyzed", "unsupported", "not_applicable", "disabled"].includes(matches[0].outcome) && Array.isArray(matches[0].unimplemented) && matches[0].unimplemented.length === 0;
    }),
  };
}
