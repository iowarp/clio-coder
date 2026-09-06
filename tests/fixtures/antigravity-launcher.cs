using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A Windows executable fixture for the shell-free Antigravity spawn contract.
// Forward the original argv, cwd, environment, stdio, and exit code to the same
// Node fixture used on POSIX. No shell or production spawn replacement is used.
internal static class AntigravityLauncher
{
    private static string QuoteArgument(string value)
    {
        var quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            quoted.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        // Backslashes before a closing quote must be doubled for Windows argv.
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        var arguments = new StringBuilder(QuoteArgument(Path.Combine(root, "fake.mjs")));
        foreach (string argument in args)
        {
            arguments.Append(' ');
            arguments.Append(QuoteArgument(argument));
        }
        var start = new ProcessStartInfo
        {
            FileName = File.ReadAllText(Path.Combine(root, "node-executable.txt")),
            Arguments = arguments.ToString(),
            WorkingDirectory = Environment.CurrentDirectory,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        // With redirection disabled, the child inherits the runtime's pipes.
        using (Process child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
