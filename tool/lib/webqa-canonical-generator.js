// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Silei Xu <silei@cs.stanford.edu>
//
// See COPYING for details
"use strict";
const fs = require('fs');
const util = require('util');
const path = require('path');
const child_process = require('child_process');

const { makeLookupKeys } = require('../../lib/sample-utils');

const ANNOTATED_PROPERTIES = [
    'url', 'name', 'description',
    'geo', 'address.streetAddress', 'address.addressCountry', 'address.addressRegion', 'address.addressLocality'
];


// turn entity type into string
function entityTypeToString(type) {
    if (type.isArray)
        return entityTypeToString(type.elem);
    else if (type.isEntity)
        return type.type;
    else
        return null;
}

// split the canonical into prefix and suffix
function splitCanonical(canonical) {
    let prefix, suffix;
    if (!canonical.includes('#'))
        [prefix, suffix] = [canonical, ''];
    else if (canonical.includes('#') && !canonical.startsWith('#'))
        [prefix, suffix] = canonical.split('#').map((span) => span.trim());
    else
        [prefix, suffix] = ['', canonical.slice(1).trim()];
    return [prefix, suffix];
}

// return the template query of a certain grammar category
function templateQuery(cat, tableName, prefix, value='', suffix='') {
    switch (cat) {
        case 'base':
            return `what is the ${prefix} of the ${tableName} ?`.split(/\s+/g);
        case 'npp':
        case 'property':
            return `show me ${tableName} with ${prefix} ${value} ${suffix} .`.split(/\s+/g);
        case 'avp':
        case 'verb':
            return `which ${tableName} ${prefix} ${value} ${suffix} ?`.split(/\s+/g);
        case 'pvp':
        case 'passive_verb':
            return `show me a ${tableName} ${prefix} ${value} ${suffix} .`.split(/\s+/g);
        case 'npi':
        case 'reverse_property':
            return `which ${tableName} is a ${prefix} ${value} ${suffix} ?`.split(/\s+/g);
        default:
            throw new Error(`Invalid grammar category ${cat}`);
    }
}


class CanonicalGenerator {
    constructor(classDef, constants, queries, parameterDatasets, options) {
        this.class = classDef;
        this.constants = constants;
        this.queries = queries;

        this.pruning = options.pruning;
        this.mask = options.mask;
        this.is_paraphraser = options.is_paraphraser;
        this.model = options.model;

        this.parameterDatasets = parameterDatasets;
        this.parameterDatasetPaths = {};

        this.sampleSize = {};

        this.options = options;
    }


    async generate() {
        await this._loadParameterDatasetPaths();

        const examples = {};
        const paths = {};
        for (let qname of this.queries) {
            examples[qname] = {};
            paths[qname] = { canonical: this.class.queries[qname].canonical, params: {} };
            let query = this.class.queries[qname];
            let typeCounts = this._getArgTypeCount(qname);
            for (let arg of query.iterateArguments()) {
                if (ANNOTATED_PROPERTIES.includes(arg.name))
                    continue;

                // get the paths to the data
                let p = path.dirname(this.parameterDatasets) + '/'  + this._getDatasetPath(qname, arg);
                if (p && fs.existsSync(p))
                    paths[qname]['params'][`${arg.name}`] = p;

                // some args don't have canonical: e.g., id, name
                if (!arg.metadata.canonical)
                    continue;

                // copy base canonical if npp canonical is missing
                if (arg.metadata.canonical.base && !arg.metadata.canonical.npp)
                    arg.metadata.canonical.npp = [...arg.metadata.canonical.base];

                // if npp is missing, try to use entity type info
                if (!('npp' in arg.metadata.canonical)) {
                    let typestr = entityTypeToString(query.getArgType(arg.name));
                    // only apply this if the type is unique
                    if (typestr && typeCounts[typestr] === 1) {
                        let base = typestr.substring(typestr.indexOf(':') + 1)
                            .replace(/_/, ' ')
                            .toLowerCase()
                            .trim();
                        arg.metadata.canonical['npp'] = [base];
                        arg.metadata.canonical['base'] = [base];
                    }
                }

                const samples = this._retrieveSamples(qname, arg);
                if (samples) {
                    this.sampleSize[`${qname}.${arg.name}`] = samples.length;
                    examples[qname][arg.name] = this._generateExamples(query.canonical, arg.metadata.canonical, samples);
                }
            }
        }

        const args = [path.resolve(path.dirname(module.filename), './bert-canonical-generator.py'), 'all'];
        if (this.is_paraphraser)
            args.push('--is-paraphraser');
        args.push('--model-name-or-path');
        args.push(this.model);
        args.push(this.mask ? '--mask' : '--no-mask');

        // call bert to generate candidates
        const child = child_process.spawn(`python3`, args, { stdio: ['pipe', 'pipe', 'inherit'] });

        const output = util.promisify(fs.writeFile);
        if (this.options.debug)
            await output(`./bert-annotator-in.json`, JSON.stringify({ examples, paths }, null, 2));

        const stdout = await new Promise((resolve, reject) => {
            child.stdin.write(JSON.stringify( { examples, paths } ));
            child.stdin.end();
            child.on('error', reject);
            child.stdout.on('error', reject);
            child.stdout.setEncoding('utf8');
            let buffer = '';
            child.stdout.on('data', (data) => {
                buffer += data;
            });
            child.stdout.on('end', () => resolve(buffer));
        });

        if (this.options.debug)
            await output(`./bert-annotator-out.json`, JSON.stringify(JSON.parse(stdout), null, 2));

        const { synonyms, adjectives } = JSON.parse(stdout);
        this._updateCanonicals(synonyms, adjectives);
        return this.class;
    }

    _getArgTypeCount(qname) {
        const schema = this.class.queries[qname];
        const count = {};
        for (let arg of schema.iterateArguments()) {
            let typestr = entityTypeToString(schema.getArgType(arg.name));
            if (!typestr)
                continue;
            if (typestr in count)
                count[typestr] += 1;
            else
                count[typestr] = 1;
        }
        return count;
    }

    async _loadParameterDatasetPaths() {
        const rows = (await (util.promisify(fs.readFile))(this.parameterDatasets, { encoding: 'utf8' })).split('\n');
        for (let row of rows) {
            let [, key, path] = row.split('\t');
            this.parameterDatasetPaths[key] = path;
        }
    }

    _getDatasetPath(qname, arg) {
        const keys = [
            `${this.class.kind}:${qname}_${arg.name}`,
            `${arg.type.isEntity ? arg.type.type : arg.type}`
        ];
        for (let key of keys) {
            if (this.parameterDatasetPaths[key])
                return this.parameterDatasetPaths[key];
        }
        return null;
    }

    _updateCanonicals(candidates, adjectives) {
        for (let qname of this.queries) {
            for (let arg in candidates[qname]) {
                let canonicals = this.class.queries[qname].getArgument(arg).metadata.canonical;
                if (adjectives.includes(`${qname}.${arg}`))
                        canonicals['apv'] = true;

                for (let type in candidates[qname][arg]) {
                    let count = candidates[qname][arg][type].candidates;
                    let max = candidates[qname][arg][type].examples.filter((e) => e.candidates.length > 0).length;
                    for (let candidate in count) {
                        if (count[candidate] > max * this.pruning) {
                            if (!canonicals[type].includes(candidate))
                                canonicals[type].push(candidate);
                        }
                    }

                }
            }
        }
    }

    _retrieveSamples(qname, arg) {
        const keys = makeLookupKeys('@' + this.class.kind + '.' + qname, arg.name, arg.type);
        let samples;
        for (let key of keys) {
            if (this.constants[key]) {
                samples = this.constants[key];
                break;
            }
        }
        if (samples) {
            samples = samples.map((v) => {
                if (arg.type.isString)
                    return v.value;
                return v.display;
            });
        }
        return samples;
    }

    _generateExamples(tableName, canonicals, valueSample) {
        let examples = {};
        for (let cat of ['base', 'npp', 'avp', 'pvp', 'npi']) {
            if (cat in canonicals)
                examples[cat] = { examples: [], candidates: [] } ;
        }

        if ('base' in canonicals) {
            for (let canonical of canonicals['base']) {
                let query = templateQuery('base', tableName, canonical);
                let maskIndices = canonical.split(' ').map((w) => query.indexOf(w));
                examples['base']['examples'].push({
                    query: query.join(' '),
                    masks: {prefix: maskIndices, suffix: []},
                    value: []
                });
            }
        }

        for (let value of valueSample) {
            for (let cat in canonicals) {
                if (['default', 'apv', 'npv', 'base'].includes(cat))
                    continue;
                for (let canonical of canonicals[cat]) {
                    let [prefix, suffix] = splitCanonical(canonical);
                    let query = templateQuery(cat, tableName, prefix, value, suffix);
                    let prefixIndices = prefix ? prefix.split(' ').map((w) => query.indexOf(w)) : [];
                    let suffixIndices = suffix ? suffix.split(' ').map((w) => query.indexOf(w)) : [];
                    let valueIndices = value.split(' ').map((w) => query.indexOf(w));
                    examples[cat]['examples'].push({
                        query: query.join(' '),
                        masks: { prefix: prefixIndices, suffix: suffixIndices },
                        value: valueIndices
                    });
                }
            }
        }
        return examples;
    }
}

module.exports = CanonicalGenerator;
