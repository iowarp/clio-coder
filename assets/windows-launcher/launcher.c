/*
 * Clio Coder's native Windows launcher, installed as `git.exe` in the managed
 * git shim directory and as `clio-coder.exe` by the Windows installer. A
 * `.cmd` in that place runs its arguments through cmd.exe, which expands
 * %NAME% even inside quotes and lets an unbalanced quote turn `&` into a
 * command separator; nothing inside a batch file can undo that. This launcher
 * replaces the batch hop: it starts one program with the caller's command line
 * appended unchanged after argv[0], so the program splits it exactly as the
 * caller meant. No shell runs, so nothing is expanded.
 *
 * What to start is read from `<name>.launch` beside this file (UTF-8):
 *   line 1  the program to start, an absolute path
 *   line 2  arguments placed before the caller's, already quoted (may be empty)
 *   line 3+ options, one per line: `utf8-console` sets the console input and
 *           output code pages to UTF-8 while the program runs
 * Built without a C runtime by scripts/build-windows-launcher.mjs.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define TEXT_LIMIT 32768

static WCHAR module_path[TEXT_LIMIT];
static char launch_utf8[TEXT_LIMIT];
static WCHAR launch_text[TEXT_LIMIT];
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
		if (at >= TEXT_LIMIT - 1) fail("clio-coder launcher: command line too long\n");
		target[at++] = *text++;
	}
	target[at] = 0;
	return at;
}

static int same(const WCHAR *left, const WCHAR *right) {
	while (*left != 0 && *left == *right) {
		left++;
		right++;
	}
	return *left == *right;
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

/* `<this file without .exe>.launch`, decoded into launch_text; returns its length. */
static int read_launch_file(void) {
	HANDLE file;
	DWORD size = 0;
	DWORD length = GetModuleFileNameW(NULL, module_path, TEXT_LIMIT);
	int stem = (int)length;
	int start = 0;
	int converted;
	if (length == 0 || length >= TEXT_LIMIT - 16) fail("clio-coder launcher: cannot locate itself\n");
	if (stem > 4 && module_path[stem - 4] == L'.' && (module_path[stem - 3] | 0x20) == L'e' &&
		(module_path[stem - 2] | 0x20) == L'x' && (module_path[stem - 1] | 0x20) == L'e')
		stem -= 4;
	module_path[stem] = 0;
	append(module_path, stem, L".launch");
	file = CreateFileW(module_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
		OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
	if (file == INVALID_HANDLE_VALUE) fail("clio-coder launcher: its .launch file is missing; reinstall Clio Coder\n");
	if (!ReadFile(file, launch_utf8, TEXT_LIMIT - 1, &size, NULL)) size = 0;
	CloseHandle(file);
	if (size >= 3 && (unsigned char)launch_utf8[0] == 0xEF && (unsigned char)launch_utf8[1] == 0xBB &&
		(unsigned char)launch_utf8[2] == 0xBF)
		start = 3;
	if ((int)size <= start) fail("clio-coder launcher: its .launch file is empty\n");
	converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, launch_utf8 + start, (int)size - start,
		launch_text, TEXT_LIMIT - 1);
	if (converted <= 0) fail("clio-coder launcher: its .launch file is not UTF-8\n");
	launch_text[converted] = 0;
	return converted;
}

/* Ctrl+C reaches the program through the shared console; it decides and this waits. A handler is not inherited, unlike ignoring. */
static BOOL WINAPI ignore_console_event(DWORD event) {
	(void)event;
	return TRUE;
}

void launch(void) {
	STARTUPINFOW startup;
	PROCESS_INFORMATION child;
	DWORD exit_code = 1;
	UINT input_page = 0;
	UINT output_page = 0;
	const WCHAR *tail = argument_tail();
	const WCHAR *lines[64];
	int count = 0;
	int length = read_launch_file();
	int at = 0;
	int index;
	int utf8_console = 0;
	lines[count++] = launch_text;
	for (index = 0; index < length && count < 64; index++) {
		if (launch_text[index] != L'\n') continue;
		launch_text[index] = 0;
		if (index > 0 && launch_text[index - 1] == L'\r') launch_text[index - 1] = 0;
		lines[count++] = launch_text + index + 1;
	}
	if (length > 0 && launch_text[length - 1] == L'\r') launch_text[length - 1] = 0;
	if (lines[0][0] == 0) fail("clio-coder launcher: its .launch file names no program\n");
	for (index = 2; index < count; index++)
		if (same(lines[index], L"utf8-console")) utf8_console = 1;
	at = append(command, at, L"\"");
	at = append(command, at, lines[0]);
	at = append(command, at, L"\"");
	if (count > 1 && lines[1][0] != 0) {
		at = append(command, at, L" ");
		at = append(command, at, lines[1]);
	}
	if (*tail != 0) {
		at = append(command, at, L" ");
		at = append(command, at, tail);
	}
	if (utf8_console) {
		input_page = GetConsoleCP();
		output_page = GetConsoleOutputCP();
		if (input_page != 0) SetConsoleCP(CP_UTF8);
		if (output_page != 0) SetConsoleOutputCP(CP_UTF8);
	}
	GetStartupInfoW(&startup);
	SetConsoleCtrlHandler(ignore_console_event, TRUE);
	if (!CreateProcessW(lines[0], command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) {
		if (input_page != 0) SetConsoleCP(input_page);
		if (output_page != 0) SetConsoleOutputCP(output_page);
		fail("clio-coder launcher: cannot start the program its .launch file names\n");
	}
	CloseHandle(child.hThread);
	WaitForSingleObject(child.hProcess, INFINITE);
	if (!GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = 1;
	CloseHandle(child.hProcess);
	if (input_page != 0) SetConsoleCP(input_page);
	if (output_page != 0) SetConsoleOutputCP(output_page);
	ExitProcess(exit_code);
}
