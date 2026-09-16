import CachedImage from '@app/components/Common/CachedImage';
import defineMessages from '@app/utils/defineMessages';
import { ClockIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestModal.RequestInfoPanel', {
  movieinfo:
    'This will request the system to go add this to Plex, most movies are added within 5-10 minutes. Sometimes things take a day. If you are in a rush for it msg Christopher and he might be able to speed it up',
  tvinfo:
    'This will request the system to go add this to Plex, most episodes are added within 5-10 minutes. Sometimes things take a day. If you are in a rush for it msg Christopher and he might be able to speed it up',
  minutes: '{minutes} min',
});

interface RequestInfoPanelProps {
  type: 'movie' | 'tv';
  title?: string;
  year?: string;
  posterPath?: string;
  runtime?: number;
  overview?: string;
}

const RequestInfoPanel = ({
  type,
  title,
  year,
  posterPath,
  runtime,
  overview,
}: RequestInfoPanelProps) => {
  const intl = useIntl();

  return (
    <div className="mt-4 space-y-4">
      <div className="flex overflow-hidden rounded-lg border border-gray-700 bg-gray-800/60 shadow">
        <div className="relative hidden w-24 flex-shrink-0 sm:block">
          {posterPath ? (
            <CachedImage
              type="tmdb"
              src={`https://image.tmdb.org/t/p/w185${posterPath}`}
              alt=""
              fill
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <div className="h-full w-full bg-gray-700" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center px-4 py-3">
          <div className="truncate text-lg font-bold text-white">
            {title}
            {year && (
              <span className="ml-2 text-base font-normal text-gray-400">
                ({year})
              </span>
            )}
          </div>
          {runtime ? (
            <div className="mt-1 flex items-center text-sm text-gray-400">
              <ClockIcon className="mr-1 h-4 w-4" />
              {intl.formatMessage(messages.minutes, { minutes: runtime })}
            </div>
          ) : null}
          {overview && (
            <p className="mt-2 line-clamp-3 text-sm text-gray-300">
              {overview}
            </p>
          )}
        </div>
      </div>
      <div className="flex rounded-lg border border-indigo-500/40 bg-indigo-900/30 p-4">
        <InformationCircleIcon className="mr-3 h-6 w-6 flex-shrink-0 text-indigo-300" />
        <p className="text-sm leading-6 text-indigo-100">
          {intl.formatMessage(
            type === 'movie' ? messages.movieinfo : messages.tvinfo
          )}
        </p>
      </div>
    </div>
  );
};

export default RequestInfoPanel;
