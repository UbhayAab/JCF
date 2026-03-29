import json, codecs
with codecs.open('post_output.txt', 'r', 'utf-16le') as f:
    text = f.read()
with open('clean_post.txt', 'w', encoding='utf-8') as f:
    f.write(text)
