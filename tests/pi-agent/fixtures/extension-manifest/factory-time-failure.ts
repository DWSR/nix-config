export const PRIVATE_FACTORY_SENTINEL = "TASK_4_12_PRIVATE_FACTORY_FAILURE_SENTINEL";

export default function failDuringFactory(): never {
  throw new Error(PRIVATE_FACTORY_SENTINEL);
}
