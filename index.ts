import { Absence, AbsenceIO, Reason } from 'absence.io';
import { DateTime } from 'luxon';

import config from './config.json';

const absenceIO = new AbsenceIO({
  apiKey: config.apiKey,
  apiKeyId: config.apiKeyId,
});

const remoteWorkdays: Array<number> = [];
if (config.remoteWorkdays.monday) {
  remoteWorkdays.push(1);
}
if (config.remoteWorkdays.tuesday) {
  remoteWorkdays.push(2);
}
if (config.remoteWorkdays.wednesday) {
  remoteWorkdays.push(3);
}
if (config.remoteWorkdays.thursday) {
  remoteWorkdays.push(4);
}
if (config.remoteWorkdays.friday) {
  remoteWorkdays.push(5);
}

async function getUserId() {
  const users = await absenceIO.api.user.retrieveUsers();

  const user = users.data.find((user) => user.email === config.email);

  return user?._id;
}

async function getRemoteWorkReason() {
  const reasons = await absenceIO.api.reason.retrieveReasons();

  const remoteWorkReason = reasons.data.find(
    (reason) => reason.name === 'Remote Work',
  );

  if (!remoteWorkReason) {
    throw new Error('Remote Work reason not found');
  }

  return remoteWorkReason;
}

async function getExistingAbsencesForMonth(me: string, date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();

  const startDate = new Date(year, month, 0);
  const endDate = new Date(year, month + 1, 1);

  const absences: Array<Absence> = [];
  let page = 0;
  let done = false;
  while (!done) {
    const absencesPage = await getPaginatedAbsences(
      startDate,
      endDate,
      me,
      page,
    );

    absences.push(...absencesPage.data);
    page++;

    if (absencesPage.data.length < 1000) {
      done = true;
    }
  }

  return absences;
}

async function getPaginatedAbsences(
  startDate: Date,
  endDate: Date,
  me: string,
  page: number = 0,
) {
  const absences = await absenceIO.api.absence.retrieveAbsences({
    filter: {
      assignedToId: me,
      start: {
        $gte: startDate.toISOString(),
        $lt: endDate.toISOString(),
      },
    },
    limit: 1000,
    skip: page * 1000,
  });

  return absences;
}

function getRemoteWorkDaysForMonth(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();

  const daysThisMonth = new Date(year, month + 1, 0).getDate();

  const days: Date[] = [];
  for (let i = 1; i <= daysThisMonth; i++) {
    const d = new Date(year, month, i, date.getHours(), date.getMinutes());

    if (remoteWorkdays.includes(d.getDay())) {
      days.push(d);
    }
  }

  return days;
}

async function printAbsencesToCreateAndWaitForConfirmation(days: Date[]) {
  console.log(`Sollen für die folgenden Tage Abwesenheiten erstellt werden?`);
  days.forEach((day) => {
    console.log(day.toLocaleDateString());
  });

  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<void>((resolve, reject) => {
    readline.question(`(j/n) `, async (answer: string) => {
      readline.close();
      if (
        answer.toLowerCase().startsWith('j') ||
        answer.toLowerCase().startsWith('y')
      ) {
        resolve();
        return;
      }

      console.log('Ok dann nicht');
      reject();
      process.exit(0);
    });
  });
}

async function createAbsence(me: string, day: Date, remoteWorkReason: Reason) {
  const startDate = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const endDate = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() + 1,
  );

  const startDateString = DateTime.fromJSDate(startDate)
    .setZone('Europe/Berlin')
    .toISO();

  const endDateString = DateTime.fromJSDate(endDate)
    .setZone('Europe/Berlin')
    .toISO();

  const absence = await absenceIO.api.absence.createAbsence({
    assignedToId: me,
    approverId: me,
    start: startDateString!,
    end: endDateString!,
    reasonId: remoteWorkReason._id,
  });

  console.log(`Abwesenheit für ${day.toLocaleDateString()} erstellt`);

  return absence;
}

async function askForNextMonth(date: Date) {
  const month = date.getMonth() + 1;
  const monthString = month < 10 ? `0${month}` : `${month}`;
  const yearString = date.getFullYear();

  console.log(
    `Soll "Remote Work" für ${monthString}.${yearString} eingetragen werden?`,
  );

  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve, reject) => {
    readline.question(`(j/n) `, async (answer: string) => {
      readline.close();
      if (
        answer.toLowerCase().startsWith('j') ||
        answer.toLowerCase().startsWith('y')
      ) {
        console.log('Ok weiter gehts');
        resolve(false);
        return;
      }

      console.log('Ok dann nicht');
      resolve(true);
    });
  });
}

async function run() {
  const me = await getUserId();

  if (!me) {
    console.error(`Nutzer mit der E-Mail "${config.email}" nicht gefunden`);
    process.exit(1);
  }

  const today = new Date();
  let month = today.getMonth();

  let done = false;
  while (!done) {
    const current = new Date(today);
    current.setMonth(month);

    const remoteWorkReason = await getRemoteWorkReason();
    const absences = await getExistingAbsencesForMonth(me, current);
    const days = getRemoteWorkDaysForMonth(current);

    const daysWithoutAbsence = days.filter((day) => {
      return !absences.find((absence) => {
        const absenceStartDate = new Date(absence.start);
        const absenceEndDate = new Date(absence.end);

        return day >= absenceStartDate && day <= absenceEndDate;
      });
    });

    if (daysWithoutAbsence.length > 0) {
      await printAbsencesToCreateAndWaitForConfirmation(daysWithoutAbsence);

      await Promise.all(
        daysWithoutAbsence.map((day) =>
          createAbsence(me, day, remoteWorkReason),
        ),
      );
    } else {
      const monthString = month + 1 < 10 ? `0${month + 1}` : `${month + 1}`;
      const yearString = today.getFullYear();

      console.log(
        `Keine neuen "Remote Work" Abwesenheiten für ${monthString}.${yearString} gefunden`,
      );
    }

    month++;

    const nextDate = new Date(today);
    nextDate.setMonth(month);

    done = await askForNextMonth(nextDate);
  }

  console.log('https://app.absence.io/#/mycalendar');
  console.log('Fertig');
}
run();
