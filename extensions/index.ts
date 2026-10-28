import os from "node:os";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Catalog } from "./models.ts";
import { createHub } from "./hub.ts";
import { resolveKeyRef } from "./keyref.ts";

const catalog: Catalog = {
  providers: () => getBuiltinProviders(),
  models: (provider) =>
    getBuiltinModels(provider as BuiltinProvider) as unknown as Array<Record<string, any>>,
};

export default async function (pi: ExtensionAPI): Promise<void> {
  await createHub({
    pi,
    env: process.env,
    home: os.homedir(),
    fetchImpl: fetch,
    catalog,
    resolveKey: resolveKeyRef,
  });
}
