#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdint.h>
#include <stdio.h>
#include <wchar.h>

#ifndef FILE_DISPOSITION_FLAG_DELETE
#define FILE_DISPOSITION_FLAG_DELETE 0x00000001
#define FILE_DISPOSITION_FLAG_POSIX_SEMANTICS 0x00000002
#define FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE 0x00000010
#endif

typedef struct {
    DWORD FileAttributes;
    FILETIME CreationTime;
    FILETIME LastAccessTime;
    FILETIME LastWriteTime;
    DWORD VolumeSerialNumber;
    DWORD FileSizeHigh;
    DWORD FileSizeLow;
    DWORD NumberOfLinks;
    DWORD FileIndexHigh;
    DWORD FileIndexLow;
} CA_FILE_INFORMATION;

static int parse_u64(const wchar_t *text, uint64_t *value) {
    wchar_t *end = NULL;
    unsigned long long parsed;
    if (!text || !*text || *text == L'-') return 0;
    parsed = wcstoull(text, &end, 10);
    if (!end || *end != L'\0') return 0;
    *value = (uint64_t)parsed;
    return 1;
}

static int birthtime_ns(FILETIME creation, uint64_t *value) {
    const uint64_t epoch = 116444736000000000ULL;
    uint64_t ticks = ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
    if (ticks < epoch || ticks - epoch > UINT64_MAX / 100ULL) return 0;
    *value = (ticks - epoch) * 100ULL;
    return 1;
}

static HANDLE open_directory(const wchar_t *path, DWORD access) {
    return CreateFileW(
        path,
        access,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        NULL);
}

static int validate_identity(
    HANDLE handle,
    uint64_t expected_dev,
    uint64_t expected_ino,
    uint64_t expected_birthtime,
    int expected_directory) {
    BY_HANDLE_FILE_INFORMATION information;
    uint64_t ino, birth;
    if (!GetFileInformationByHandle(handle, &information)) return 0;
    ino = ((uint64_t)information.nFileIndexHigh << 32) | information.nFileIndexLow;
    if (!birthtime_ns(information.ftCreationTime, &birth)) return 0;
    if ((information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 0;
    if (((information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != expected_directory) {
        return 0;
    }
    return expected_dev <= UINT32_MAX
        && information.dwVolumeSerialNumber == (DWORD)expected_dev
        && ino == expected_ino
        && birth == expected_birthtime;
}

static int sid_is_allowed(PSID sid, PSID current, PSID system, PSID admins,
                          PSID creator_owner, PSID owner_rights) {
    return sid && (EqualSid(sid, current)
        || EqualSid(sid, system)
        || EqualSid(sid, admins)
        || EqualSid(sid, creator_owner)
        || EqualSid(sid, owner_rights));
}

static int validate_directory_acl(HANDLE handle, int reject_readers) {
    HANDLE token = NULL;
    TOKEN_USER *token_user = NULL;
    DWORD token_size = 0;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    PSID owner = NULL, system = NULL, admins = NULL, creator_owner = NULL, owner_rights = NULL;
    PACL dacl = NULL;
    PEXPLICIT_ACCESS_W entries = NULL;
    ULONG entry_count = 0;
    DWORD status;
    int ok = 0;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
    GetTokenInformation(token, TokenUser, NULL, 0, &token_size);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || token_size == 0) goto cleanup;
    token_user = (TOKEN_USER *)LocalAlloc(LPTR, token_size);
    if (!token_user || !GetTokenInformation(token, TokenUser, token_user, token_size, &token_size)) {
        goto cleanup;
    }
    if (!ConvertStringSidToSidW(L"S-1-5-18", &system)
        || !ConvertStringSidToSidW(L"S-1-5-32-544", &admins)
        || !ConvertStringSidToSidW(L"S-1-3-0", &creator_owner)
        || !ConvertStringSidToSidW(L"S-1-3-4", &owner_rights)) goto cleanup;

    status = GetSecurityInfo(
        handle,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        &owner,
        NULL,
        &dacl,
        NULL,
        &descriptor);
    if (status != ERROR_SUCCESS || !descriptor || !dacl) goto cleanup;
    if (!sid_is_allowed(owner, token_user->User.Sid, system, admins, creator_owner, owner_rights)) {
        goto cleanup;
    }
    status = GetExplicitEntriesFromAclW(dacl, &entry_count, &entries);
    if (status != ERROR_SUCCESS) goto cleanup;
    for (ULONG index = 0; index < entry_count; ++index) {
        EXPLICIT_ACCESS_W *entry = &entries[index];
        PSID sid;
        if (entry->grfAccessMode != GRANT_ACCESS && entry->grfAccessMode != SET_ACCESS) continue;
        if (entry->grfAccessPermissions == 0) continue;
        if (entry->Trustee.TrusteeForm != TRUSTEE_IS_SID) goto cleanup;
        sid = (PSID)entry->Trustee.ptstrName;
        if (!sid_is_allowed(sid, token_user->User.Sid, system, admins, creator_owner, owner_rights)) {
            const DWORD write_access = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA
                | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER
                | GENERIC_WRITE | GENERIC_ALL;
            if (reject_readers || (entry->grfAccessPermissions & write_access) != 0) goto cleanup;
        }
    }
    ok = 1;

cleanup:
    if (entries) LocalFree(entries);
    if (descriptor) LocalFree(descriptor);
    if (system) LocalFree(system);
    if (admins) LocalFree(admins);
    if (creator_owner) LocalFree(creator_owner);
    if (owner_rights) LocalFree(owner_rights);
    if (token_user) LocalFree(token_user);
    if (token) CloseHandle(token);
    return ok;
}

static int validate_command(int argc, wchar_t **argv) {
    uint64_t dev, ino, birth;
    HANDLE handle;
    int ok;
    if (argc != 6 || !parse_u64(argv[3], &dev) || !parse_u64(argv[4], &ino)
        || !parse_u64(argv[5], &birth)) return 2;
    handle = open_directory(argv[2], READ_CONTROL | FILE_READ_ATTRIBUTES);
    if (handle == INVALID_HANDLE_VALUE) return 3;
    ok = validate_identity(handle, dev, ino, birth, 1)
        && validate_directory_acl(handle, wcscmp(argv[1], L"validate-private-directory") == 0);
    CloseHandle(handle);
    return ok ? 0 : 4;
}

static int sync_command(int argc, wchar_t **argv) {
    uint64_t dev, ino, birth;
    HANDLE handle;
    int ok;
    if (argc != 6 || !parse_u64(argv[3], &dev) || !parse_u64(argv[4], &ino)
        || !parse_u64(argv[5], &birth)) return 2;
    handle = open_directory(argv[2], GENERIC_WRITE | FILE_READ_ATTRIBUTES);
    if (handle == INVALID_HANDLE_VALUE) return 3;
    ok = validate_identity(handle, dev, ino, birth, 1) && FlushFileBuffers(handle);
    CloseHandle(handle);
    return ok ? 0 : 4;
}

static int remove_command(int argc, wchar_t **argv) {
    uint64_t dev, ino, birth;
    int expected_directory;
    HANDLE handle;
    FILE_DISPOSITION_INFO_EX disposition;
    FILE_DISPOSITION_INFO fallback;
    FILE_STANDARD_INFO settled;
    int ok;
    if (argc != 7 || !parse_u64(argv[3], &dev) || !parse_u64(argv[4], &ino)
        || !parse_u64(argv[5], &birth)) return 2;
    if (wcscmp(argv[6], L"true") == 0) expected_directory = 1;
    else if (wcscmp(argv[6], L"false") == 0) expected_directory = 0;
    else return 2;
    handle = open_directory(argv[2], DELETE | FILE_READ_ATTRIBUTES);
    if (handle == INVALID_HANDLE_VALUE) return 3;
    if (!validate_identity(handle, dev, ino, birth, expected_directory)) {
        CloseHandle(handle);
        return 4;
    }
    disposition.Flags = FILE_DISPOSITION_FLAG_DELETE
        | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
        | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
    ok = SetFileInformationByHandle(
        handle,
        (FILE_INFO_BY_HANDLE_CLASS)21,
        &disposition,
        sizeof(disposition));
    if (!ok) {
        fallback.DeleteFile = TRUE;
        ok = SetFileInformationByHandle(
            handle,
            FileDispositionInfo,
            &fallback,
            sizeof(fallback));
    }
    if (ok) {
        ok = GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &settled,
            sizeof(settled))
            && !!settled.Directory == !!expected_directory
            && settled.DeletePending;
    }
    CloseHandle(handle);
    return ok ? 0 : 5;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) return 2;
    if (wcscmp(argv[1], L"validate-private-directory") == 0
        || wcscmp(argv[1], L"validate-directory-write-integrity") == 0) {
        return validate_command(argc, argv);
    }
    if (wcscmp(argv[1], L"sync-directory") == 0) {
        return sync_command(argc, argv);
    }
    if (wcscmp(argv[1], L"remove") == 0) {
        return remove_command(argc, argv);
    }
    return 2;
}
