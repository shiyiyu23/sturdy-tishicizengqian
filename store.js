/**
 * Durable, file-backed state for Prompt Forge.
 *
 * The playbook, its snapshots, the trace log and the benchmark are ordinary
 * files under one directory: a user can read, diff, copy or delete them
 * without the plugin. Writes are serialised per store and committed with a
 * temp-file rename, so a crash leaves either the old or the new content.
 * @module dsh-prompt-forge/store
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { describeError } from './util.js'

/** Files the store owns, so a reset removes exactly what it should. */
export const STORE_FILES = Object.freeze({
  playbook: 'playbook.json',
  state: 'state.json',
  traces: 'traces.jsonl',
  benchmark: 'benchmark.json',
  feedback: 'feedback.jsonl',
})

/**
 * One data directory holding every piece of forge state.
 */
export class Store {
  /**
   * @param {string} directory - absolute data directory.
   */
  constructor(directory) {
    this.dir = directory
    this.versionsDir = path.join(directory, 'versions')
    this.queue = Promise.resolve()
  }

  /**
   * Absolute path of one owned file.
   * @param {string} name - file name.
   * @returns {string} the absolute path.
   */
  file(name) {
    return path.join(this.dir, name)
  }

  /**
   * Run one task after every previously queued task, so concurrent tool calls
   * cannot interleave a read-modify-write of the same file.
   * @template T
   * @param {() => Promise<T>} task - the critical section.
   * @returns {Promise<T>} the task result.
   */
  serial(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Create the data and snapshot directories.
   * @returns {Promise<void>} resolution after the directories exist.
   */
  async ensure() {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(this.versionsDir, { recursive: true })
  }

  /**
   * Read one JSON file.
   *
   * A missing file yields the fallback. A corrupt file is moved aside as
   * `<name>.corrupt-<timestamp>` and also yields the fallback, so a half
   * written file can never wedge the plugin permanently.
   * @param {string} name - file name.
   * @param {unknown} fallback - value when the file is absent or unreadable.
   * @returns {Promise<unknown>} the parsed value.
   */
  async readJson(name, fallback) {
    const target = this.file(name)
    let text
    try {
      text = await fs.readFile(target, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return fallback
      throw error
    }
    try {
      return JSON.parse(text)
    } catch {
      await fs.rename(target, `${target}.corrupt-${Date.now()}`).catch(() => undefined)
      return fallback
    }
  }

  /**
   * Write one JSON file atomically.
   * @param {string} name - file name.
   * @param {unknown} value - JSON-serialisable value.
   * @returns {Promise<void>} resolution after the rename.
   */
  async writeJson(name, value) {
    await this.ensure()
    const target = this.file(name)
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, target)
  }

  /**
   * Append one record to the JSONL trace log.
   * @param {object} record - the trace record.
   * @returns {Promise<void>} resolution after the append.
   */
  async appendTrace(record) {
    await this.ensure()
    await fs.appendFile(this.file(STORE_FILES.traces), `${JSON.stringify(record)}\n`, 'utf8')
  }

  /**
   * Append one user-feedback record (a restored draft means "not good enough").
   * @param {object} record - the feedback record.
   * @returns {Promise<void>} resolution after the append.
   */
  async appendFeedback(record) {
    await this.ensure()
    await fs.appendFile(this.file(STORE_FILES.feedback), `${JSON.stringify(record)}\n`, 'utf8')
  }

  /**
   * Read every feedback record.
   * @returns {Promise<object[]>} the records, oldest first.
   */
  async readFeedback() {
    let text
    try {
      text = await fs.readFile(this.file(STORE_FILES.feedback), 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A torn last line is not worth failing the learning pass over.
      }
    }
    return records
  }

  /**
   * Read the most recent trace records.
   * @param {number} limit - maximum records returned, newest last.
   * @returns {Promise<{ records: object[], corruptLines: number, total: number }>} the tail.
   */
  async readTraces(limit) {
    let text
    try {
      text = await fs.readFile(this.file(STORE_FILES.traces), 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { records: [], corruptLines: 0, total: 0 }
      throw error
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const records = []
    let corruptLines = 0
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch {
        corruptLines += 1
      }
    }
    return { records: records.slice(Math.max(0, records.length - limit)), corruptLines, total: records.length }
  }

  /**
   * Save one playbook snapshot.
   * @param {object} playbook - the playbook to snapshot.
   * @returns {Promise<string>} the snapshot path.
   */
  async snapshot(playbook) {
    await this.ensure()
    const target = path.join(this.versionsDir, `v${playbook.version}.json`)
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(playbook, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, target)
    return target
  }

  /**
   * Read one playbook snapshot.
   * @param {number} version - snapshot version.
   * @returns {Promise<object | undefined>} the playbook, or undefined.
   */
  async readSnapshot(version) {
    try {
      const text = await fs.readFile(path.join(this.versionsDir, `v${version}.json`), 'utf8')
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  /**
   * List the snapshot versions present on disk.
   * @returns {Promise<number[]>} ascending versions.
   */
  async listVersions() {
    let names
    try {
      names = await fs.readdir(this.versionsDir)
    } catch {
      return []
    }
    return names
      .map((name) => /^v(\d+)\.json$/u.exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right)
  }

  /**
   * Delete the oldest snapshots, keeping the newest `keep`.
   * @param {number} keep - how many snapshots to retain.
   * @returns {Promise<number[]>} the versions removed.
   */
  async pruneVersions(keep) {
    const versions = await this.listVersions()
    const excess = versions.slice(0, Math.max(0, versions.length - keep))
    for (const version of excess) {
      await fs.rm(path.join(this.versionsDir, `v${version}.json`), { force: true }).catch(() => undefined)
    }
    return excess
  }

  /**
   * Probe that the data directory really accepts writes.
   * @returns {Promise<{ ok: boolean, detail: string }>} the probe result.
   */
  async probeWritable() {
    try {
      await this.ensure()
      const probe = path.join(this.dir, `.probe-${process.pid}-${Date.now()}`)
      await fs.writeFile(probe, 'ok', 'utf8')
      await fs.rm(probe, { force: true })
      return { ok: true, detail: this.dir }
    } catch (error) {
      return { ok: false, detail: `${this.dir}: ${describeError(error)}` }
    }
  }

  /**
   * Remove a set of owned files.
   * @param {string[]} names - file names to remove.
   * @returns {Promise<void>} resolution after removal.
   */
  async removeFiles(names) {
    for (const name of names) await fs.rm(this.file(name), { force: true }).catch(() => undefined)
  }
}
