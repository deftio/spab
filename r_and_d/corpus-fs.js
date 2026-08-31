/*
 * corpus-fs.js — load a corpus from a directory of files on disk.
 *
 * The corpus lives as data, not in a .js file. Two on-disk formats, mixable in
 * one tree (walked recursively, sorted for determinism):
 *   - text files (.txt/.md/.text): each file is one document.
 *   - JSONL files (.jsonl/.ndjson): each line is one document — either a bare
 *     string, or an object {id?, text} / {id?, content}.
 *
 * loadCorpus(dir, {limit}) returns { count, get(i) -> {id, text} }, reading text
 * files lazily so a directory of many files stays cheap.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var TEXT_EXT = { '.txt': 1, '.md': 1, '.text': 1, '.csv': 1, '.tsv': 1 };
var JSONL_EXT = { '.jsonl': 1, '.ndjson': 1 };

function walk(dir, out) {
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  entries.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  entries.forEach(function (e) {
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  });
  return out;
}

function loadCorpus(dir, opts) {
  opts = opts || {};
  var limit = opts.limit || Infinity;
  var files = walk(dir, []);
  var docs = []; // descriptors: {kind:'file', path} or {kind:'inline', id, text}

  for (var f = 0; f < files.length && docs.length < limit; f++) {
    var file = files[f];
    var ext = path.extname(file).toLowerCase();
    if (TEXT_EXT[ext]) {
      docs.push({ kind: 'file', path: file, id: path.relative(dir, file) });
    } else if (JSONL_EXT[ext]) {
      var lines = fs.readFileSync(file, 'utf8').split('\n');
      for (var li = 0; li < lines.length && docs.length < limit; li++) {
        var line = lines[li];
        if (!line.trim()) continue;
        var text = null, id = null;
        try {
          var obj = JSON.parse(line);
          if (typeof obj === 'string') text = obj;
          else if (obj && typeof obj === 'object') { text = obj.text != null ? obj.text : obj.content; id = obj.id; }
        } catch (e) { text = line; }
        if (text != null) docs.push({ kind: 'inline', id: id || (path.basename(file) + ':' + li), text: text });
      }
    }
    // other extensions ignored
  }
  if (docs.length > limit) docs.length = limit;

  return {
    count: docs.length,
    get: function (i) {
      var d = docs[i];
      if (d.kind === 'inline') return { id: d.id, text: d.text };
      return { id: d.id, text: fs.readFileSync(d.path, 'utf8') };
    }
  };
}

module.exports = { loadCorpus: loadCorpus, walk: walk };
