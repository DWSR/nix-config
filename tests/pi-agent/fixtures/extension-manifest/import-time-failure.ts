export const PRIVATE_IMPORT_SENTINEL = "TASK_4_12_PRIVATE_IMPORT_FAILURE_SENTINEL";

throw new Error(PRIVATE_IMPORT_SENTINEL);

export default function mustNotLoad(): never {
  throw new Error(PRIVATE_IMPORT_SENTINEL);
}
