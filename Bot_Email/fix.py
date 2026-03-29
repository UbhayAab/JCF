import json, codecs
with codecs.open('put_out.txt', 'r', 'utf-16le') as f:
    text = f.read()
with open('clean_out.txt', 'w', encoding='utf-8') as f:
    f.write(text)
