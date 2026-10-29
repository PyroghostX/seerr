import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { CheckIcon, WrenchIcon } from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import type {
  AvailabilityMismatchFineResponse,
  AvailabilityMismatchFixedResponse,
  AvailabilityMismatchItem,
  AvailabilityMismatchResultsResponse,
} from '@server/interfaces/api/availabilityMismatchInterfaces';
import axios from 'axios';
import Link from 'next/link';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.AvailabilityMismatchList', {
  mismatches: 'Mismatches',
  description:
    'Seasons where Plex shows a different number of episodes than Sonarr has files for. Mark one Fine when the difference is expected (for example a double-episode file), or fix it and press Fixed to check again.',
  filterOpen: 'Open',
  filterFine: 'Fine',
  filterFixed: 'Fixed',
  filterResolved: 'Resolved on Its Own',
  filterAll: 'All',
  season: 'Season {seasonNumber}',
  counts: 'Plex {plexEpisodes} · Sonarr {sonarrEpisodes}',
  firstSeen: 'First seen {date}',
  resolvedBy: '{status} by {user}',
  unknownTitle: 'Unknown Series',
  fine: 'Fine',
  fixed: 'Fixed',
  statusOpen: 'Open',
  statusFine: 'Fine',
  statusFixed: 'Fixed',
  statusResolved: 'Resolved',
  noOpenMismatches: 'No mismatches. Plex and Sonarr agree on every season.',
  noMismatches: 'Nothing here yet.',
  markedFine: '<strong>{title}</strong> season {seasonNumber} marked as fine.',
  markedFineAvailable:
    '<strong>{title}</strong> season {seasonNumber} marked as fine and as available.',
  markedFixed:
    '<strong>{title}</strong> season {seasonNumber} matches now and is marked as fixed.',
  stillMismatched:
    '<strong>{title}</strong> season {seasonNumber} still differs: Plex {plexEpisodes}, Sonarr {sonarrEpisodes}.',
  actionFailed: 'Something went wrong. Please try again.',
});

type Filter = 'open' | 'fine' | 'fixed' | 'resolved' | 'all';

const statusMessages = {
  open: messages.statusOpen,
  fine: messages.statusFine,
  fixed: messages.statusFixed,
  resolved: messages.statusResolved,
};

const statusBadgeTypes = {
  open: 'warning',
  fine: 'default',
  fixed: 'success',
  resolved: 'success',
} as const;

interface MismatchItemProps {
  mismatch: AvailabilityMismatchItem;
  revalidateList: () => void;
}

const MismatchItem = ({ mismatch, revalidateList }: MismatchItemProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);
  const title = mismatch.title || intl.formatMessage(messages.unknownTitle);
  const toastValues = {
    title,
    seasonNumber: mismatch.seasonNumber,
    strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
  };

  const markFine = async () => {
    setIsUpdating(true);

    try {
      const response = await axios.post<AvailabilityMismatchFineResponse>(
        `/api/v1/mismatch/${mismatch.id}/fine`
      );

      addToast(
        <span>
          {intl.formatMessage(
            response.data.markedAvailable
              ? messages.markedFineAvailable
              : messages.markedFine,
            toastValues
          )}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.actionFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    revalidateList();
    setIsUpdating(false);
  };

  const markFixed = async () => {
    setIsUpdating(true);

    try {
      await axios.post<AvailabilityMismatchFixedResponse>(
        `/api/v1/mismatch/${mismatch.id}/fixed`
      );

      addToast(
        <span>{intl.formatMessage(messages.markedFixed, toastValues)}</span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch (e) {
      const current = axios.isAxiosError<AvailabilityMismatchFixedResponse>(e)
        ? e.response?.status === 409
          ? e.response.data.mismatch
          : undefined
        : undefined;

      if (current) {
        addToast(
          <span>
            {intl.formatMessage(messages.stillMismatched, {
              ...toastValues,
              plexEpisodes: current.plexEpisodes,
              sonarrEpisodes: current.sonarrEpisodes,
            })}
          </span>,
          { appearance: 'warning', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(messages.actionFailed), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }

    revalidateList();
    setIsUpdating(false);
  };

  return (
    <div className="flex w-full flex-col justify-between rounded-xl bg-gray-800 p-4 text-gray-400 shadow-md ring-1 ring-gray-700 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2">
          {mismatch.tmdbId ? (
            <Link
              href={`/tv/${mismatch.tmdbId}`}
              className="truncate text-lg font-bold text-white hover:underline xl:text-xl"
            >
              {title}
            </Link>
          ) : (
            <span className="truncate text-lg font-bold text-white xl:text-xl">
              {title}
            </span>
          )}
          <Badge badgeType={statusBadgeTypes[mismatch.status]}>
            {intl.formatMessage(statusMessages[mismatch.status])}
          </Badge>
        </div>
        <div className="mt-1 text-sm">
          <span className="font-semibold text-gray-200">
            {intl.formatMessage(messages.season, {
              seasonNumber: mismatch.seasonNumber,
            })}
          </span>
          <span className="mx-2">·</span>
          <span>
            {intl.formatMessage(messages.counts, {
              plexEpisodes: mismatch.plexEpisodes,
              sonarrEpisodes: mismatch.sonarrEpisodes,
            })}
          </span>
        </div>
        <div className="mt-1 text-sm">
          {intl.formatMessage(messages.firstSeen, {
            date: (
              <FormattedRelativeTime
                value={Math.floor(
                  (new Date(mismatch.firstSeenAt).getTime() - Date.now()) / 1000
                )}
                updateIntervalInSeconds={1}
                numeric="auto"
              />
            ),
          })}
          {mismatch.resolvedBy && (
            <>
              <span className="mx-2">·</span>
              {intl.formatMessage(messages.resolvedBy, {
                status: intl.formatMessage(statusMessages[mismatch.status]),
                user: mismatch.resolvedBy.displayName,
              })}
            </>
          )}
        </div>
      </div>
      {mismatch.status === 'open' && (
        <div className="mt-4 flex flex-shrink-0 space-x-2 sm:ml-4 sm:mt-0">
          <Button
            buttonType="default"
            buttonSize="sm"
            disabled={isUpdating}
            onClick={() => markFine()}
          >
            <CheckIcon />
            <span>{intl.formatMessage(messages.fine)}</span>
          </Button>
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={isUpdating}
            onClick={() => markFixed()}
          >
            <WrenchIcon />
            <span>{intl.formatMessage(messages.fixed)}</span>
          </Button>
        </div>
      )}
    </div>
  );
};

const AvailabilityMismatchList = () => {
  const intl = useIntl();
  const [currentFilter, setCurrentFilter] = useState<Filter>('open');

  const { data, error, mutate } = useSWR<AvailabilityMismatchResultsResponse>(
    `/api/v1/mismatch?status=${currentFilter}`
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.mismatches)} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{intl.formatMessage(messages.mismatches)}</Header>
        <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
          <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
            <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
              <FunnelIcon className="h-6 w-6" />
            </span>
            <select
              id="filter"
              name="filter"
              onChange={(e) => setCurrentFilter(e.target.value as Filter)}
              value={currentFilter}
              className="rounded-r-only"
            >
              <option value="open">
                {intl.formatMessage(messages.filterOpen)}
              </option>
              <option value="fine">
                {intl.formatMessage(messages.filterFine)}
              </option>
              <option value="fixed">
                {intl.formatMessage(messages.filterFixed)}
              </option>
              <option value="resolved">
                {intl.formatMessage(messages.filterResolved)}
              </option>
              <option value="all">
                {intl.formatMessage(messages.filterAll)}
              </option>
            </select>
          </div>
        </div>
      </div>
      <p className="mb-4 text-sm text-gray-400">
        {intl.formatMessage(messages.description)}
      </p>
      {!data ? (
        <LoadingSpinner />
      ) : data.results.length === 0 ? (
        <div className="flex w-full flex-col items-center justify-center py-24 text-center text-white">
          <span className="text-2xl text-gray-400">
            {intl.formatMessage(
              currentFilter === 'open'
                ? messages.noOpenMismatches
                : messages.noMismatches
            )}
          </span>
        </div>
      ) : (
        data.results.map((mismatch) => (
          <div className="py-2" key={`mismatch-item-${mismatch.id}`}>
            <MismatchItem mismatch={mismatch} revalidateList={() => mutate()} />
          </div>
        ))
      )}
    </>
  );
};

export default AvailabilityMismatchList;
