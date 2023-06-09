import { error, warning, info, debug, setOutput } from '@actions/core';
import { execSync, spawn } from 'child_process';
import ms from 'milliseconds';
import kill from 'tree-kill';

import { getInputs, getTimeout, Inputs, hasPatternSource } from './inputs';
import { retryWait, wait } from './util';

const OS = process.platform;
const OUTPUT_TOTAL_ATTEMPTS_KEY = 'total_attempts';
const OUTPUT_EXIT_CODE_KEY = 'exit_code';
const OUTPUT_EXIT_ERROR_KEY = 'exit_error';

let exit: number;
let done: boolean;
let output_pattern_matched: boolean;

function getExecutable(inputs: Inputs): string {
  if (!inputs.shell) {
    return OS === 'win32' ? 'powershell' : 'bash';
  }

  let executable: string;
  switch (inputs.shell) {
    case 'bash':
    case 'python':
    case 'pwsh': {
      executable = inputs.shell;
      break;
    }
    case 'sh': {
      if (OS === 'win32') {
        throw new Error(`Shell ${inputs.shell} not allowed on OS ${OS}`);
      }
      executable = inputs.shell;
      break;
    }
    case 'cmd':
    case 'powershell': {
      if (OS !== 'win32') {
        throw new Error(`Shell ${inputs.shell} not allowed on OS ${OS}`);
      }
      executable = inputs.shell + '.exe';
      break;
    }
    default: {
      throw new Error(
        `Shell ${inputs.shell} not supported.  See https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsshell for supported shells`
      );
    }
  }
  return executable;
}

async function runRetryCmd(inputs: Inputs): Promise<void> {
  // if no retry script, just continue
  if (!inputs.on_retry_command) {
    return;
  }

  try {
    await execSync(inputs.on_retry_command, { stdio: 'inherit' });
    // eslint-disable-next-line
  } catch (error: any) {
    info(`WARNING: Retry command threw the error ${error.message}`);
  }
}

async function runCmd(attempt: number, inputs: Inputs) {
  const timeout = getTimeout(inputs);
  const end_time = timeout && Date.now() + timeout;
  const executable = getExecutable(inputs);

  exit = 0;
  done = false;
  output_pattern_matched = false;
  let timeout_reached = false;

  debug(`Running command ${inputs.command} on ${OS} using shell ${executable}`);
  const child =
    attempt > 1 && inputs.new_command_on_retry
      ? spawn(inputs.new_command_on_retry, { shell: executable })
      : spawn(inputs.command, { shell: executable });

  const outputChunks: Buffer[] = [];

  child.stdout?.on('data', (data) => {
    process.stdout.write(data);
    if (hasPatternSource(inputs, 'stdout')) outputChunks.push(Buffer.from(data));
  });
  child.stderr?.on('data', (data) => {
    process.stdout.write(data);
    if (hasPatternSource(inputs, 'stderr')) outputChunks.push(Buffer.from(data));
  });

  child.on('exit', (code, signal) => {
    debug(`Code: ${code}`);
    debug(`Signal: ${signal}`);
    if (inputs.retry_on_pattern) {
      const outputString = Buffer.concat(outputChunks).toString('utf8');
      output_pattern_matched = inputs.retry_on_pattern.test(outputString);
    }

    // timeouts are killed manually
    if (signal === 'SIGTERM') {
      return;
    }

    // On Windows signal is null.
    if (timeout_reached) {
      return;
    }

    if (code && code > 0) {
      exit = code;
    }

    done = true;
  });

  do {
    await wait(ms.seconds(inputs.polling_interval_seconds));
  } while ((!end_time || Date.now() < end_time) && !done);

  if (!done && child.pid) {
    timeout_reached = true;
    kill(child.pid);
    await retryWait(ms.seconds(inputs.retry_wait_seconds));
    throw new Error(`Timeout of ${getTimeout(inputs)}ms hit`);
  } else if (exit > 0) {
    await retryWait(ms.seconds(inputs.retry_wait_seconds));
    throw new Error(`Child_process exited with error code ${exit}`);
  } else {
    return;
  }
}

async function runAction(inputs: Inputs) {
  for (let attempt = 1; attempt <= inputs.max_attempts; attempt++) {
    try {
      // just keep overwriting attempts output
      setOutput(OUTPUT_TOTAL_ATTEMPTS_KEY, attempt);
      await runCmd(attempt, inputs);
      info(`Command completed after ${attempt} attempt(s).`);
      break;
      // eslint-disable-next-line
    } catch (error: any) {
      if (attempt === inputs.max_attempts) {
        throw new Error(`Final attempt failed. ${error.message}`);
      } else if (!done && inputs.retry_on === 'error') {
        // error: timeout
        throw error;
      } else if (inputs.retry_on_exit_code && inputs.retry_on_exit_code !== exit) {
        throw error;
      } else if (exit > 0 && inputs.retry_on === 'timeout') {
        // error: error
        throw error;
      } else if (exit > 0 && inputs.retry_on_pattern && !output_pattern_matched) {
        // error: error & pattern did not match
        warning(
          `Early exited because the output didn't match the pattern: '${inputs.retry_on_pattern}'`
        );
        throw error;
      } else {
        await runRetryCmd(inputs);
        if (inputs.warning_on_retry) {
          warning(`Attempt ${attempt} failed. Reason: ${error.message}`);
        } else {
          info(`Attempt ${attempt} failed. Reason: ${error.message}`);
        }
      }
    }
  }
}

const inputs = getInputs();

runAction(inputs)
  .then(() => {
    setOutput(OUTPUT_EXIT_CODE_KEY, 0);
    process.exit(0); // success
  })
  .catch((err) => {
    // exact error code if available, otherwise just 1
    const exitCode = exit > 0 ? exit : 1;

    if (inputs.continue_on_error) {
      warning(err.message);
    } else {
      error(err.message);
    }

    // these can be  helpful to know if continue-on-error is true
    setOutput(OUTPUT_EXIT_ERROR_KEY, err.message);
    setOutput(OUTPUT_EXIT_CODE_KEY, exitCode);

    // if continue_on_error, exit with exact error code else exit gracefully
    // mimics native continue-on-error that is not supported in composite actions
    process.exit(inputs.continue_on_error ? 0 : exitCode);
  });
