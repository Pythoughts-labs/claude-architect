#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "token") == 0) {
        DWORD tokenPid = (DWORD)strtoul(argv[2], NULL, 10);
        FILETIME creationTime, exitTime, kernelTime, userTime;
        HANDLE tokenProcess;
        ULONGLONG creationValue;
        if (tokenPid <= 1) return 1;
        tokenProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, tokenPid);
        if (!tokenProcess) return GetLastError() == ERROR_INVALID_PARAMETER ? 2 : 1;
        if (!GetProcessTimes(tokenProcess, &creationTime, &exitTime, &kernelTime, &userTime)) {
            CloseHandle(tokenProcess);
            return 1;
        }
        creationValue = ((ULONGLONG)creationTime.dwHighDateTime << 32) | creationTime.dwLowDateTime;
        printf("%llu", creationValue);
        CloseHandle(tokenProcess);
        return 0;
    }
    if (argc != 2) return 1;
    DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
    if (pid <= 1) return 1;
    HANDLE h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, FALSE, pid);
    if (!h) return GetLastError() == ERROR_INVALID_PARAMETER ? 2 : 1; /* 2: already gone */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) { CloseHandle(h); return 1; }
    /* If the target is already in a job we cannot join, fall back to TerminateProcess tree-root. */
    if (!AssignProcessToJobObject(job, h)) {
        BOOL inJob = FALSE; IsProcessInJob(h, NULL, &inJob);
        if (!inJob) { CloseHandle(job); CloseHandle(h); return 1; }
    }
    BOOL ok = TerminateJobObject(job, 137);
    if (!ok) ok = TerminateProcess(h, 137);
    CloseHandle(job); CloseHandle(h);
    return ok ? 0 : 1;
}
