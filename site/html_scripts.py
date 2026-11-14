"""Collect executable inline script bodies without treating HTML as a regex."""
from html.parser import HTMLParser


JAVASCRIPT_TYPES = {
    '', 'module',
    'application/ecmascript', 'application/javascript',
    'application/x-ecmascript', 'application/x-javascript',
    'text/ecmascript', 'text/javascript', 'text/jscript', 'text/livescript',
    'text/x-ecmascript', 'text/x-javascript',
    *(f'text/javascript1.{version}' for version in range(6)),
}


class ScriptParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self._scripts = []
        self._current_script = None

    @property
    def inline_scripts(self):
        return [''.join(parts) for parts in self._scripts]

    def handle_starttag(self, tag, attrs):
        if tag != 'script':
            return
        attributes = dict(attrs)
        media_type = (attributes.get('type') or '').split(';', 1)[0].strip().lower()
        self._current_script = None
        if 'src' not in attributes and media_type in JAVASCRIPT_TYPES:
            self._current_script = []
            self._scripts.append(self._current_script)

    def handle_endtag(self, tag):
        if tag == 'script':
            self._current_script = None

    def handle_data(self, data):
        if self._current_script is not None:
            self._current_script.append(data)
