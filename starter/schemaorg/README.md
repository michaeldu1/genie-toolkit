# Starter Code for Schema2QA

This directory contains the basic starter code to train a single-sentence
Q\&A semantic parsing model from a Schema.org schema.

## Installation
The starter code requires`nodejs` (>=10.0) and `yarn` as a package manager. 
See [nodejs](https://nodejs.org/en/download/) and [yarn](https://classic.yarnpkg.com/en/docs/install/) for installation details. 
You can check your installation by running `node --version` and `yarn --version`.

In addition, you will need [thingpedia-cli](https://github.com/stanford-oval/thingpedia-cli),
which provides an easy way to download data from and upload data to Thingpedia. 
Run the following command to install it: 
```bash
yarn global add thingpedia-cli
```

After installation, you should get a command called `thingpedia`.
If encounter `command not found`, make sure the Yarn global bin directory
(usually `~/.yarn/bin`) is in your PATH. You can find the path with the command
`yarn global bin`.

```bash
export PATH=~/.yarn/bin:$PATH
```

## Configuration

Edit `Makefile` and set `developer_key` to your Thingpedia developer key.
A Thingpedia developer account is required to obtain the developer key. 
[Register an Almond account](https://almond.stanford.edu/user/register) 
and [sign up as a developer](https://almond.stanford.edu/user/request-developer), 
then you can retrieve the developer key 
from your [user profile](https://almond.stanford.edu/user/profile) page

You can also create a file called 'config.mk' with your settings if you don't
want to edit the Makefile directly.

## Usage

All commands accept an "experiment=" option, setting which experiment
to run. An experiment is a specific set of domains in Schema.org ontology,
with associated datasets and models.

The starter code contains data for 6 domains: `restaurants`, `hotels`, `people`, `movies`
`music`, `books`. In total, we have 7 experiments: one for each domain, and an additional
one `multidomain`, which contains all the 6 domains. 

You can add more experiments by editing the `Makefile` and adding them to `all_experiments`,
as well as creating new per-experiment variables.

### Acquire Schema.org Metadata from Websites
Schema.org proposes a standard ontology for various domains. 
However, different websites for the same domain might use a different set of properties, and provide
data in different format. 
Thus, Schema2QA replies on real Schema.org metadata to decide the final schema, and generate training data.

We have prepared source data for the 6 domains by crawling existing Schema.org metadata from 
Yelp, Hyatt, LinkedIn, IMDb, Last.fm, and Goodreads, respectively. 


### Generate Manifest and Value Datasets
The manifest.tt file contains the manifest of the Q\&A agent to build, including all the queries and properties 
available for each query. 
Genie can automatically generate manifest.tt given crawled Schema.org metadata. 
Use 
```bash
make experiment=$(exp) $(exp)/manifest.tt
```

Manifest.tt also include natural language annotations for queries and their properties, describing
how they can be referred in natural language. 
By default, Genie uses the manual annotations declared in `tool/autoqa/schemaorg/manual-anotations.js`. 
One can disable that by
```bash
make experiment=$(exp) mode=base $(exp)/manifest.tt
```
in which case, only a simple heuristics-based algorithm is used to generate the annotation based on 
the name of the property. 

Genie can also automatically generate natural language annotations using pretrained language models. 
To enable that, run 
```bash
make experiment=$(exp) mode=auto $(exp)/manifest.tt
```

One can also fine-tune natural language annotations, by updating
`MANUAL_PROPERTY_CANONICAL_OVERRIDE` or `MANUAL_PROPERTY_CANONICAL_OVERRIDE_BY_DOMAIN` in 
tool/autoqa/schemaorg/manual-annotations.js`. 

### Generate a dataset

Use:
```
make experiment=$(exp) datadir
```
To generate a dataset.

The starter code is tuned to generate a full dataset, which will consume a lot of memory and take a long time.
Use the following options to control the dataset size:
```
make experiment=... max_depth=8 target_pruning_size=500 datadir
```
Set a smaller depth or pruning size for faster generation.

### Train

Use:
```
make experiment=$(exp) model=$(model) train
```
Set `model` to a unique identifier of the model. By default, the model is called "1".

Training takes about 7 hours on a single V100 GPU.
The model is saved in `$(exp)/models/$(model)`.

### Evaluate

The starter code includes evaluation data crowd sourced from Amazon MTruk for the existing
6 domains. `multidomain` experiments contains the evaluation data for all 6 domains. 
```bash
make experiment=$(exp) model=$(model) evaluate
```

If you obtain your own evaluation data, you can add it to `$(experiment)/eval/annotated.tsv` for the dev set,
and `$(experiment)/test/annotated.tsv` for the test set. 
Data added to the dev set will be also used during training for cross-validation.
You can change the evaluation set
by setting `eval_set` to "eval" or "test" as:
```bash
make experiment=$(exp) model=$(model) eval_set=$(eval-set) evaluate
```

