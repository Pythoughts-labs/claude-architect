export class BoundedBuffer {
  private parts: Buffer[] = []; private size = 0; truncated = false;
  constructor(private readonly maxBytes: number) {}
  push(chunk: Buffer) {
    if (this.size >= this.maxBytes) { this.truncated = true; return; }
    const room = this.maxBytes - this.size;
    if (chunk.length > room) { this.parts.push(chunk.subarray(0, room)); this.size = this.maxBytes; this.truncated = true; }
    else { this.parts.push(chunk); this.size += chunk.length; }
  }
  toString() { return Buffer.concat(this.parts).toString("utf8"); }
}
