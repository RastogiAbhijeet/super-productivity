import {Injectable} from '@angular/core';
import {Worklog, WorklogDay, WorklogTask, WorklogWeek} from './worklog.model';
import {EntityState} from '@ngrx/entity';
import {Task} from '../tasks/task.model';
import {dedupeByKey} from '../../util/de-dupe-by-key';
import {PersistenceService} from '../../core/persistence/persistence.service';
import {ProjectService} from '../project/project.service';
import {BehaviorSubject, combineLatest, Observable} from 'rxjs';
import {map, switchMap} from 'rxjs/operators';
import {getWeekNumber} from '../../util/get-week-number';
import {Project} from '../project/project.model';
import {mapArchiveToWorklog} from './map-archive-to-worklog';

const EMPTY_ENTITY = {
  ids: [],
  entities: {},
};

@Injectable({
  providedIn: 'root'
})
export class WorklogService {
  private _archiveUpdateTrigger$ = new BehaviorSubject(true);

  // NOTE: task updates are not reflected
  worklogData$: Observable<{ worklog: Worklog; totalTimeSpent: number }> = combineLatest([
    this._projectService.currentProject$,
    this._archiveUpdateTrigger$,
  ]).pipe(
    switchMap(([curProject]) => {
      return this._loadForProject(curProject);
    }),
  );

  worklog: Worklog;
  worklog$: Observable<Worklog> = this.worklogData$.pipe(map(data => data.worklog));
  totalTimeSpent$: Observable<number> = this.worklogData$.pipe(map(data => data.totalTimeSpent));
  currentWeek$: Observable<WorklogWeek> = this.worklog$.pipe(
    map(worklog => {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const weekNr = getWeekNumber(now);

      if (worklog[year] && worklog[year].ent[month]) {
        return worklog[year].ent[month].weeks.find(week => week.weekNr === weekNr);
      }
    }),
  );

  constructor(
    private readonly _persistenceService: PersistenceService,
    private readonly _projectService: ProjectService,
  ) {
    this.worklog$.subscribe(worklog => this.worklog = worklog);
  }


  refreshWorklog() {
    this._archiveUpdateTrigger$.next(true);
  }

  // TODO this is not waiting for worklog data
  getTaskListForRange(rangeStart: Date, rangeEnd: Date, isFilterOutTimeSpentOnOtherDays = false): WorklogTask[] {
    let tasks = this._getAllWorklogTasks();

    tasks = tasks.filter((task) => {
      const taskDate = new Date(task.dateStr);
      return (taskDate >= rangeStart && taskDate <= rangeEnd);
    });

    if (isFilterOutTimeSpentOnOtherDays) {
      tasks = tasks.map((task): WorklogTask => {

        const timeSpentOnDay = {};
        Object.keys(task.timeSpentOnDay).forEach(dateStr => {
          const date = new Date(dateStr);

          if (date >= rangeStart && date <= rangeEnd) {
            timeSpentOnDay[dateStr] = task.timeSpentOnDay[dateStr];
          }
        });

        return {
          ...task,
          timeSpentOnDay
        };
      });
    }

    return dedupeByKey(tasks, 'id');
  }

  private _getAllWorklogTasks(): WorklogTask[] {
    const worklog: Worklog = this.worklog;
    let tasks: WorklogTask[] = [];

    Object.keys(worklog).forEach((yearKeyIN) => {
      const yearKey = +yearKeyIN;
      const year = worklog[yearKey];

      if (year && year.ent) {
        Object.keys(year.ent).forEach(monthKeyIN => {
          // needs de-normalization
          const monthKey = +monthKeyIN;
          const month = year.ent[monthKey];

          if (month && month.ent) {
            Object.keys(month.ent).forEach(dayKeyIN => {
              const dayKey = +dayKeyIN;
              const day: WorklogDay = month.ent[dayKey];
              if (day) {
                tasks = tasks.concat(this._createTasksForDay(day));
              }
            });
          }
        });
      }
    });
    return tasks;
  }


  private async _loadForProject(project: Project): Promise<{ worklog: Worklog; totalTimeSpent: number }> {
    const archive = await this._persistenceService.taskArchive.load(project.id) || EMPTY_ENTITY;
    const taskState = await this._persistenceService.task.load(project.id) || EMPTY_ENTITY;
    const startEnd = {
      workStart: project.workStart,
      workEnd: project.workEnd,
    };

    const completeState: EntityState<Task> = {
      ids: [...archive.ids, ...taskState.ids] as string[],
      entities: {
        ...archive.entities,
        ...taskState.entities
      }
    };

    if (completeState) {
      const {worklog, totalTimeSpent} = mapArchiveToWorklog(completeState, taskState.ids, startEnd);
      return {
        worklog,
        totalTimeSpent,
      };
    } else {
      return {
        worklog: {},
        totalTimeSpent: null
      };
    }
  }

  private _createTasksForDay(data: WorklogDay): WorklogTask[] {
    const dayData = {...data};

    return dayData.logEntries.map((entry) => {
      return {
        ...entry.task,
        timeSpent: entry.timeSpent,
        dateStr: dayData.dateStr,
      };
    });
  }
}
