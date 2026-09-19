export type OmpFrame = Record<string, unknown>;

export const MAX_RPC_FRAME_BYTES = 1_048_576;
export const MAX_RPC_REASSEMBLED_BYTES = 67_108_864;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const MAX_RPC_CHUNK_BASE64_CHARS = Math.ceil(RPC_CHUNK_PAYLOAD_BYTES / 3) * 4;

interface RpcChunk {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

export class RpcChunkDecoder {
  #maxPhysical = MAX_RPC_FRAME_BYTES;
  #maxLogical = MAX_RPC_REASSEMBLED_BYTES;
  #chunkId: string | undefined;
  #count = 0;
  #byteLength = 0;
  #nextIndex = 0;
  #written = 0;
  #assembly: Buffer | undefined;

  setLimits(maxPhysical: number, maxLogical: number): void {
    this.#maxPhysical = maxPhysical;
    this.#maxLogical = maxLogical;
  }

  hasPending(): boolean {
    return this.#assembly !== undefined;
  }

  reset(): void {
    this.#chunkId = undefined;
    this.#count = 0;
    this.#byteLength = 0;
    this.#nextIndex = 0;
    this.#written = 0;
    this.#assembly = undefined;
  }

  push(value: OmpFrame): OmpFrame | undefined {
    if (value.type !== "rpc_chunk") {
      if (this.hasPending()) {
        this.#abort("rpc chunk sequence interrupted");
      }
      return value;
    }
    const chunk = this.#parseChunk(value);
    const bytes = this.#decodePayload(chunk.data);
    this.#bindChunk(chunk);
    this.#append(bytes);
    return this.#nextIndex === this.#count ? this.#finish() : undefined;
  }

  #parseChunk(value: OmpFrame): RpcChunk {
    const { chunkId, index, count, byteLength, data } = value;
    if (
      !this.#isChunkId(chunkId) ||
      !this.#isSafeInteger(index) ||
      !this.#isSafeInteger(count) ||
      !this.#isSafeInteger(byteLength) ||
      typeof data !== "string" ||
      data.length === 0 ||
      !this.#metadataFits(index, count, byteLength)
    ) {
      this.#abort("invalid rpc chunk metadata");
    }
    return { chunkId, index, count, byteLength, data };
  }

  #isChunkId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 128;
  }

  #isSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value);
  }

  #metadataFits(index: number, count: number, byteLength: number): boolean {
    const maxChunks = Math.ceil(this.#maxLogical / RPC_CHUNK_PAYLOAD_BYTES);
    if (count < 2 || count > maxChunks || index < 0 || index >= count) {
      return false;
    }
    return byteLength >= this.#maxPhysical && byteLength <= this.#maxLogical;
  }

  #decodePayload(data: string): Buffer {
    if (data.length > MAX_RPC_CHUNK_BASE64_CHARS) {
      this.#abort("invalid rpc chunk payload");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(data, "base64");
    } catch {
      this.#abort("invalid rpc chunk payload");
    }
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES ||
      bytes.toString("base64") !== data
    ) {
      this.#abort("invalid rpc chunk payload");
    }
    return bytes;
  }

  #bindChunk(chunk: RpcChunk): void {
    if (this.#assembly === undefined) {
      if (chunk.index !== 0) {
        this.#abort("rpc chunk sequence mismatch");
      }
      this.#chunkId = chunk.chunkId;
      this.#count = chunk.count;
      this.#byteLength = chunk.byteLength;
      this.#nextIndex = 0;
      this.#written = 0;
      this.#assembly = Buffer.alloc(chunk.byteLength);
      return;
    }
    if (
      chunk.chunkId !== this.#chunkId ||
      chunk.count !== this.#count ||
      chunk.byteLength !== this.#byteLength ||
      chunk.index !== this.#nextIndex
    ) {
      this.#abort("rpc chunk sequence mismatch");
    }
  }

  #append(bytes: Buffer): void {
    const assembly = this.#assembly;
    if (assembly === undefined || this.#written + bytes.byteLength > this.#byteLength) {
      this.#abort("rpc chunk length mismatch");
    }
    bytes.copy(assembly, this.#written);
    this.#written += bytes.byteLength;
    this.#nextIndex += 1;
  }

  #finish(): OmpFrame {
    const assembly = this.#assembly;
    if (assembly === undefined || this.#written !== this.#byteLength) {
      this.#abort("rpc chunk length mismatch");
    }
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        assembly.subarray(0, this.#written),
      );
      value = JSON.parse(text);
    } catch {
      this.#abort("invalid reassembled rpc frame");
    }
    if (!this.#isLogicalFrame(value)) {
      this.#abort("invalid reassembled rpc frame");
    }
    this.reset();
    return value;
  }

  #isLogicalFrame(value: unknown): value is OmpFrame {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as OmpFrame).type !== "rpc_chunk"
    );
  }

  #abort(message: string): never {
    this.reset();
    throw new Error(message);
  }
}
