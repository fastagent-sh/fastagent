import { createHash, createHmac } from "node:crypto";

/** SHA-256 / HMAC-SHA-256 over node:crypto, in the shape SigV4's signer takes. */
export class Sha256 {
  private readonly hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    const key = secret instanceof ArrayBuffer ? Buffer.from(secret) : secret;
    this.hash = key === undefined ? createHash("sha256") : createHmac("sha256", key as string | NodeJS.ArrayBufferView);
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(data instanceof ArrayBuffer ? Buffer.from(data) : (data as string | NodeJS.ArrayBufferView));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}
