/*
 * Clio Coder managed git launcher for Windows: `git.exe` in the managed git
 * shim directory. cmd.exe expands %NAME% in the arguments of `git.cmd`, even
 * inside quotes, and nothing inside a batch file can undo that. This launcher
 * replaces the batch hop: it hands the caller's command line, unchanged after
 * argv[0], to `node git-shim.cjs` beside it, so Node splits it exactly as
 * git.exe would. No shell runs, so nothing is expanded.
 *
 * The Node executable is named in `git-shim.node` (UTF-8, one line) beside
 * this file. Built without a C runtime by scripts/build-git-shim.mjs.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define TEXT_LIMIT 32768

static WCHAR module_path[TEXT_LIMIT];
static WCHAR node_path[TEXT_LIMIT];
static char node_utf8[TEXT_LIMIT];
static WCHAR command[TEXT_LIMIT];

/* Freestanding builds still let the compiler emit these for struct copies. */
void *memset(void *target, int value, SIZE_T size) {
	unsigned char *at = (unsigned char *)target;
	while (size-- > 0) *at++ = (unsigned char)value;
	return target;
}

void *memcpy(void *target, const void *source, SIZE_T size) {
	unsigned char *to = (unsigned char *)target;
	const unsigned char *from = (const unsigned char *)source;
	while (size-- > 0) *to++ = *from++;
	return target;
}

static void fail(const char *message) {
	HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
	DWORD length = 0;
	DWORD written;
	while (message[length] != 0) length++;
	if (error != NULL && error != INVALID_HANDLE_VALUE) WriteFile(error, message, length, &written, NULL);
	ExitProcess(127);
}

static int append(WCHAR *target, int at, const WCHAR *text) {
	while (*text != 0) {
		if (at >= TEXT_LIMIT - 1) fail("clio-coder: git command line too long\n");
		target[at++] = *text++;
	}
	target[at] = 0;
	return at;
}

/* The caller's arguments as given: argv[0] skipped by the MSVCRT rule, the rest untouched. */
static const WCHAR *argument_tail(void) {
	const WCHAR *at = GetCommandLineW();
	if (*at == L'"') {
		at++;
		while (*at != 0 && *at != L'"') at++;
		if (*at == L'"') at++;
	} else {
		while (*at != 0 && *at != L' ' && *at != L'\t') at++;
	}
	while (*at == L' ' || *at == L'\t') at++;
	return at;
}

static void read_node_path(int directory_length) {
	HANDLE file;
	DWORD size = 0;
	int start = 0;
	int end;
	int converted;
	module_path[directory_length] = 0;
	append(module_path, directory_length, L"git-shim.node");
	file = CreateFileW(module_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
		FILE_ATTRIBUTE_NORMAL, NULL);
	if (file == INVALID_HANDLE_VALUE) fail("clio-coder: git-shim.node is missing beside git.exe\n");
	if (!ReadFile(file, node_utf8, TEXT_LIMIT - 1, &size, NULL)) size = 0;
	CloseHandle(file);
	end = (int)size;
	if (end >= 3 && (unsigned char)node_utf8[0] == 0xEF && (unsigned char)node_utf8[1] == 0xBB &&
		(unsigned char)node_utf8[2] == 0xBF)
		start = 3;
	while (end > start && (node_utf8[end - 1] == '\r' || node_utf8[end - 1] == '\n' || node_utf8[end - 1] == ' ')) end--;
	if (end <= start) fail("clio-coder: git-shim.node names no Node executable\n");
	converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, node_utf8 + start, end - start, node_path,
		TEXT_LIMIT - 1);
	if (converted <= 0) fail("clio-coder: git-shim.node is not UTF-8\n");
	node_path[converted] = 0;
}

/* Ctrl+C reaches git through the shared console; git decides and this waits. A handler is not inherited, unlike ignoring. */
static BOOL WINAPI ignore_console_event(DWORD event) {
	(void)event;
	return TRUE;
}

void launch(void) {
	STARTUPINFOW startup;
	PROCESS_INFORMATION child;
	DWORD exit_code = 1;
	DWORD length = GetModuleFileNameW(NULL, module_path, TEXT_LIMIT);
	int directory_length = (int)length;
	int at = 0;
	const WCHAR *tail = argument_tail();
	if (length == 0 || length >= TEXT_LIMIT - 32) fail("clio-coder: cannot locate the git shim\n");
	while (directory_length > 0 && module_path[directory_length - 1] != L'\\' && module_path[directory_length - 1] != L'/')
		directory_length--;
	read_node_path(directory_length);
	at = append(command, at, L"\"");
	at = append(command, at, node_path);
	at = append(command, at, L"\" \"");
	module_path[directory_length] = 0;
	at = append(command, at, module_path);
	at = append(command, at, L"git-shim.cjs\"");
	if (*tail != 0) {
		at = append(command, at, L" ");
		at = append(command, at, tail);
	}
	GetStartupInfoW(&startup);
	SetConsoleCtrlHandler(ignore_console_event, TRUE);
	if (!CreateProcessW(node_path, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child))
		fail("clio-coder: cannot start Node for the git shim\n");
	CloseHandle(child.hThread);
	WaitForSingleObject(child.hProcess, INFINITE);
	if (!GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = 1;
	CloseHandle(child.hProcess);
	ExitProcess(exit_code);
}
