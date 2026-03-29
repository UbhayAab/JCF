import json, codecs
with codecs.open('verb_output.txt', 'r', 'utf-16le') as f:
    text = f.read()
with open('clean_verb.txt', 'w', encoding='utf-8') as f:
    f.write(text)
