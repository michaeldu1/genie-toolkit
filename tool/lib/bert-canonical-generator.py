import csv
import argparse
import json
import torch
import sys
from transformers import BertTokenizer, BertModel, BertForMaskedLM

BLACK_LIST = ['a', 'an', 'the', 'its', 'their', 'his', 'her']

# Load tokenizer
tokenizer = BertTokenizer.from_pretrained('bert-large-uncased')

# Load pre-trained model (weights)
model = BertForMaskedLM.from_pretrained('bert-large-uncased')
model.eval()


class BertLM:
    def __init__(self, domain, examples, mask, k):
        """
        :param domain: an object contains the canonical form and paths to parameters for each table in the domain
        :param examples: an object of examples for each grammar category of each property of each table
        :param mask: a boolean indicates if we do masking before prediction
        :param k: number of top candidates to return per example
        """
        self.mask = mask
        self.k = k
        self.canonicals = {}
        self.values = {}
        for table in domain:
            self.canonicals[table] = domain[table]['canonical']
            self.values[table] = {}
            for param in domain[table]['params']:
                self.values[table][param] = self.load_values(domain[table]['params'][param])
        self.examples = examples

    def predict_one(self, table, arg, query, word, k):
        """
        Get top-k predictions at the position of `word` in `text`

        :param table: the function/table used in the command
        :param arg: the argument used in the command
        :param query: a string where `word` appears once
        :param word: a string of word which we want to find the alternatives
        :param k: number of top candidates to return, this defaults to self.k if absent
        :return: a array in length k of predicted tokens
        """
        if k is None:
            k = self.k

        if self.mask:
            query = query.replace(word, '[MASK]')
            word = '[MASK]'
        text = '[CLS] ' + query + ' [SEP]'

        tokenized_text = tokenizer.tokenize(text)
        indexed_tokens = tokenizer.convert_tokens_to_ids(tokenized_text)
        masked_index = tokenized_text.index(word)

        # Create the segments tensors.
        segments_ids = [0] * len(tokenized_text)

        # Convert inputs to PyTorch tensors
        tokens_tensor = torch.tensor([indexed_tokens])
        segments_tensors = torch.tensor([segments_ids])

        # Predict all tokens
        with torch.no_grad():
            predictions = model(tokens_tensor, segments_tensors)

        mask = predictions[0][0, masked_index]
        scores, indices = torch.topk(mask, max(k, 100))

        candidates = tokenizer.convert_ids_to_tokens(indices.tolist())
        topk = []
        for candidate in candidates:
            if candidate == word:
                continue
            if candidate in BLACK_LIST:
                continue
            if not candidate.isalpha():
                continue
            if self.canonicals[table] in candidate:
                continue
            if arg is not None and arg in self.values[table] and candidate in self.values[table][arg]:
                continue
            topk.append(candidate)
            if len(topk) == k:
                return topk
        return topk

    def predict_one_type(self, table, arg, query, masks):
        """
        Get predictions for one grammar category of given a query

        :param table: the function/table used in the command
        :param arg: the argument used in the command
        :param query: a string of the original command
        :param masks: an object containing the indices we want to predict in the form of `{ prefix: [], suffix: [] }`
        :return: an array of generated new canonicals
        """
        candidates = []
        for i in [*masks['prefix'], *masks['suffix']]:
            predictions = self.predict_one(table, arg, query, query.split(' ')[i], None)
            for token in predictions:
                candidate = self.construct_canonical(query, masks, i, token)
                candidates.append(candidate)
        return candidates

    def predict(self):
        """
        Get top-k predictions for all examples

        :return: updated examples with additional candidates field for new canonicals
        """
        for table, arg, pos in ((a, b, c) for a in self.examples for b in self.examples[a] for c in self.examples[a][b]):
            count = {}
            for example in self.examples[table][arg][pos]['examples']:
                query, masks = example['query'], example['masks']
                candidates = self.predict_one_type(table, arg, query, masks)
                example['candidates'] = candidates
                for candidate in candidates:
                    if candidate in count:
                        count[candidate] += 1
                    else:
                        count[candidate] = 1
            self.examples[table][arg][pos]['candidates'] = count

        return self.examples

    def predict_adjectives(self, k=500):
        """
        Predict which property can be used as an adjective form

        :param k: number of top candidates to generate
        :return: an array of properties
        """
        properties = []
        for table in self.values:
            query_canonical = self.canonicals[table]
            predictions = self.predict_one(table, None, 'show me a [MASK] ' + query_canonical, '[MASK]', k)
            for param in self.values[table]:
                values = self.values[table][param]
                for v in predictions:
                    if v in values:
                        properties.append(table + '.' + param)
                        break
        return properties

    @staticmethod
    def load_values(path):
        """
        Load values from a given tsv file
        :param path: a string of the path to the tsv file
        :return: an array of string values
        """
        values = []
        with open(path, 'r', encoding='utf-8') as tsvfile:
            rows = csv.reader(tsvfile, delimiter='\t')
            for row in rows:
                if len(row) > 1:
                    values.append(row[1])
        return values

    @staticmethod
    def construct_canonical(query, masks, current_index, replacement):
        """
        Construct the full canonical form after getting the prediction

        :param query: a string of the original query
        :param masks: an object containing the indices we want to predict in the form of `{ prefix: [], suffix: [] }`
        :param current_index: the index of where `replacement` should be in `query`
        :param replacement: a string to be used to replace word in original query
        :return: A string represents the new canonical form
        """
        query = query.split(' ')
        prefix, suffix = [], []
        for i in masks['prefix']:
            if i == current_index:
                prefix.append(replacement)
            else:
                prefix.append(query[i])

        for i in masks['suffix']:
            if i == current_index:
                suffix.append(replacement)
            else:
                suffix.append(query[i])

        if len(suffix) > 0:
            return ' '.join(prefix) + ' #' + ' '.join(suffix)
        return ' '.join(prefix)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command',
                        choices=['adjectives', 'synonyms', 'all'],
                        help='Which command do you want to run?')
    parser.add_argument('--mask',
                        action='store_true',
                        default=True,
                        help='mask token before predicting')
    parser.add_argument('--no-mask',
                        action='store_false',
                        dest='mask',
                        help='predict without masking tokens')
    parser.add_argument('--k-synonyms',
                        dest='k',
                        type=int,
                        default=5,
                        help='top-k candidates per example to return when generating synonyms')
    parser.add_argument('--k-adjectives',
                        type=int,
                        default=500,
                        help='top-k candidates to return when generating adjectives')
    args = parser.parse_args()

    examples, domain = json.load(sys.stdin).values()

    bert = BertLM(domain, examples, args.mask, args.k)

    output = {}
    if args.command == 'synonyms' or args.command == 'all':
        output['synonyms'] = bert.predict()
    if args.command == 'adjectives' or args.command == 'all':
        output['adjectives'] = bert.predict_adjectives(args.k_adjectives)

    print(json.dumps(output))