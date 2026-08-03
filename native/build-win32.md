# Windows native helpers

## Process-tree helper

The x64 helper was built by Windows CI with MSVC:

```text
cl /O2 /W4 win32-job-kill.c /Fe:bin\win32-job-kill-x64.exe
```

The arm64 helper is reproducibly cross-compiled with the pinned Zig toolchain:

```text
zig cc -target aarch64-windows-gnu -O2 -s -Wl,/Brepro \
  win32-job-kill.c -o bin/win32-job-kill-arm64.exe
```

Both terminate a tree with `<pid>` and print the process creation FILETIME for
`token <pid>`. Current SHA-256 values:

```text
a96636f4d9e564b978172662e005e2a521205dd3b2eaea271b511854a05ccd10  win32-job-kill-x64.exe
7ad8352f04a098212dc8884dbf9d02f9f3edb56ccc2f417a6b5bf8bdf960cc93  win32-job-kill-arm64.exe
```

## Filesystem helper

`win32-filesystem.c` has three commands:

- `validate-private-directory <path> <dev> <ino> <birthtime-ns>`
- `validate-directory-write-integrity <path> <dev> <ino> <birthtime-ns>`
- `sync-directory <path> <dev> <ino> <birthtime-ns>`
- `remove <path> <dev> <ino> <birthtime-ns> <true|false>`

Windows CI rebuilds each architecture-specific filesystem helper with the
pinned Zig toolchain, byte-compares it with the reviewed committed binary, and
then exercises that binary in platform tests.

The committed x64 and arm64 binaries were reproducibly cross-compiled with Zig
0.15.2 (archive SHA-256
`3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b`):

```text
zig cc -target x86_64-windows-gnu -O2 -s -municode -Wl,/Brepro \
  win32-filesystem.c -ladvapi32 -o bin/win32-filesystem-x64.exe
zig cc -target aarch64-windows-gnu -O2 -s -municode -Wl,/Brepro \
  win32-filesystem.c -ladvapi32 -o bin/win32-filesystem-arm64.exe
```

Current SHA-256 values:

```text
6562c2ab80c102a98c971f034396d4ee3360f4415ff589a8daceffa39a3d722e  win32-filesystem-x64.exe
19ac23c91fe1be69f27aa1c7c676831ea7832650aaa1fad8a7bc52cf50e1d3d9  win32-filesystem-arm64.exe
```

Rebuilds must update these hashes and pass the real Windows adversarial tests.
