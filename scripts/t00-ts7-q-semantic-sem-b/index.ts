import { defaultSemanticContractSupport, type SemanticContractSupport } from "../t00-ts7-q-semantic-contract-support";
import { batchSdkSyntax } from "./queries";

export { witnesses, limitations } from "./witnesses";
export const support: SemanticContractSupport = {
  ...defaultSemanticContractSupport,
  project: (oracle, path, files, ownership, context) => {
    const projection = defaultSemanticContractSupport.project(oracle, path, files, ownership, context);
    return context?.witness.index === 109 ? batchSdkSyntax(projection, oracle, path) : projection;
  },
};
