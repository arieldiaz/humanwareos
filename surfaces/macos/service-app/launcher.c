/*
 * Service launcher: the signed app's main executable.
 *
 *   <launcher> run <service-name> -- <command> [args...]
 *
 * Starts <command> as a child, so the signed app stays the parent and the
 * process macOS holds responsible. Forwards SIGTERM, SIGINT and SIGHUP to the
 * child, waits for it, and exits with its status (128+signal when the child
 * dies by signal). No configuration, no network, no other behaviour.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid = 0;
static const int forwarded_signals[] = {SIGTERM, SIGINT, SIGHUP};
#define FORWARDED_COUNT (sizeof forwarded_signals / sizeof forwarded_signals[0])

static void forward(int signal_number) {
    if (child_pid > 0) kill((pid_t)child_pid, signal_number);
}

static int usage(const char *program) {
    fprintf(stderr, "usage: %s run <service-name> -- <command> [args...]\n", program);
    return 64;
}

int main(int argc, char **argv) {
    const char *program = argc > 0 ? argv[0] : "launcher";
    if (argc < 5 || strcmp(argv[1], "run") != 0 || argv[2][0] == '\0' || strcmp(argv[3], "--") != 0) {
        return usage(program);
    }
    const char *service = argv[2];
    char **command = &argv[4];

    /* Block forwarded signals until the child's pid is known, so none is lost. */
    sigset_t forwarded, previous;
    sigemptyset(&forwarded);
    for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaddset(&forwarded, forwarded_signals[i]);
    sigprocmask(SIG_BLOCK, &forwarded, &previous);

    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = forward;
    action.sa_flags = SA_RESTART;
    sigemptyset(&action.sa_mask);
    for (size_t i = 0; i < FORWARDED_COUNT; i++) sigaction(forwarded_signals[i], &action, NULL);

    /* The child starts with the original mask and default dispositions. */
    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    posix_spawnattr_setsigmask(&attributes, &previous);
    posix_spawnattr_setsigdefault(&attributes, &forwarded);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

    pid_t pid;
    int error = posix_spawnp(&pid, command[0], NULL, &attributes, command, environ);
    posix_spawnattr_destroy(&attributes);
    if (error != 0) {
        fprintf(stderr, "%s: service %s: cannot start %s: %s\n", program, service, command[0], strerror(error));
        return 127;
    }
    child_pid = pid;
    sigprocmask(SIG_SETMASK, &previous, NULL);

    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            fprintf(stderr, "%s: service %s: waitpid: %s\n", program, service, strerror(errno));
            return 70;
        }
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 70;
}
