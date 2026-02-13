
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type MemoryItem } from "./types.js";

export class ArchiveManager {
  private archivePath: string;

  constructor(
    private readonly baseDir: string,
    private readonly logger: OpenClawPluginApi["logger"]
  ) {
    this.archivePath = path.join(this.baseDir, "mem0-archive.jsonl");
  }

  /**
   * Search the archive using keyword matching.
   * Streaming implementation for low memory footprint on large files.
   */
  async search(query: string, limit: number = 10): Promise<MemoryItem[]> {
    if (!fs.existsSync(this.archivePath)) {
      return [];
    }

    const results: MemoryItem[] = [];
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
    
    if (keywords.length === 0) return [];

    const fileStream = fs.createReadStream(this.archivePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    this.logger.debug?.(`[mem0] Deep search started for keywords: ${keywords.join(", ")}`);

    let scanned = 0;
    let malformed = 0;
    for await (const line of rl) {
      scanned++;
      if (!line.trim()) continue;

      try {
        // Optimization: Quick string check before JSON parse
        const lineLower = line.toLowerCase();
        // AND Logic: Line must contain ALL keywords to be a match? 
        // Or OR Logic? Let's go with simple OR for recall, ranked later.
        // Actually, for "Deep Search", precision matters. Let's try to match at least one significant keyword.
        const matches = keywords.some(k => lineLower.includes(k));
        
        if (matches) {
          const mem = JSON.parse(line) as MemoryItem;
          // Double check memory content (json parse validates structure)
          // Mark scope
          mem._scope = "long-term"; // Archived is always long-term
          // Add a flag to indicate it's from archive
          (mem as any)._source = "archive";
          results.push(mem);
        }
      } catch (e) {
        malformed++;
      }
    }

    // Basic ranking: Prefer items containing MORE keywords
    results.sort((a, b) => {
      const countA = keywords.filter(k => a.memory.toLowerCase().includes(k)).length;
      const countB = keywords.filter(k => b.memory.toLowerCase().includes(k)).length;
      return countB - countA; // Descending
    });

    this.logger.debug?.(`[mem0] Deep search scanned ${scanned} lines, found ${results.length} matches`);
    if (malformed > 0) {
      this.logger.debug?.(`[mem0] Deep search skipped ${malformed} malformed archive lines`);
    }

    return results.slice(0, limit);
  }

  /**
   * Write memories to archive
   */
  async archive(memories: MemoryItem[]) {
    if (!memories.length) return;
    const data = memories.map(m => JSON.stringify(m)).join("\n") + "\n";
    fs.appendFileSync(this.archivePath, data, "utf-8");
  }
}
