# Windows process-tree helper

The helper binary is committed from Windows CI and is not yet present in this repository.

Build with MSVC from the `native` directory:

```text
cl /O2 /W4 win32-job-kill.c /Fe:bin\win32-job-kill-x64.exe
```

Or cross-compile with MinGW:

```text
x86_64-w64-mingw32-gcc -O2 -o bin/win32-job-kill-x64.exe win32-job-kill.c
```

In addition to terminating a process tree with `<pid>`, the helper accepts
`token <pid>` and prints that process's creation FILETIME as a decimal value.

On every rebuild, record the SHA-256 of the committed binary in this file.
