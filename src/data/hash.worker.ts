/// <reference lib="webworker" />
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex } from "@noble/hashes/utils";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const hash = bytesToHex(blake2b(new Uint8Array(event.data), { dkLen: 32 }));
    self.postMessage({ hash });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "哈希计算失败" });
  }
};
