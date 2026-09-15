import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal.UpgradeRequestModal', {
  upgradetitle: 'Upgrade Quality to 1080',
  upgradeexplainer:
    'This title is already available. An upgrade request will have the system upgrade this from 720p to 1080p quality',
  whichseasons: 'Which seasons to upgrade to 1080p?',
  currentprofile: 'Current quality profile: {profile}',
  seasoncurrent: 'currently {resolution}p',
  seasonunknown: 'no file information',
  seasonalready1080: 'already 1080p',
  seasonrequested: 'upgrade already requested',
  requestupgrade: 'Request Upgrade',
  upgradeseasons:
    'Upgrade {seasonCount, plural, one {# Season} other {# Seasons}}',
  selectseason: 'Select a season',
  upgradeSuccess:
    'Upgrade for <strong>{title}</strong> requested successfully!',
  upgradeerror: 'Something went wrong while submitting the upgrade request.',
});

interface UpgradeRequestModalProps {
  tmdbId: number;
  type: 'movie' | 'tv';
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const UpgradeRequestModal = ({
  tmdbId,
  type,
  onCancel,
  onComplete,
  onUpdating,
}: UpgradeRequestModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>([]);
  const { data, error } = useSWR<MovieDetails | TvDetails>(
    `/api/v1/${type}/${tmdbId}`,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const title = data
    ? type === 'movie'
      ? (data as MovieDetails).title
      : (data as TvDetails).name
    : '';

  // Seasons the user can pick from (TV only): available in the library, with a
  // known resolution below 1080p and no open upgrade request yet.
  const seasonRows = useMemo(() => {
    if (type !== 'tv' || !data) {
      return [];
    }
    const tv = data as TvDetails;
    const resolutions = new Map(
      (tv.seasonResolutions ?? []).map((s) => [s.seasonNumber, s.resolution])
    );
    const requested = new Set(
      (tv.mediaInfo?.requests ?? [])
        .filter(
          (r: MediaRequest) =>
            r.isUpgrade && !r.is4k && r.status !== MediaRequestStatus.DECLINED
        )
        .flatMap((r: MediaRequest) => r.seasons.map((s) => s.seasonNumber))
    );
    return (tv.mediaInfo?.seasons ?? [])
      .filter(
        (season) =>
          season.seasonNumber > 0 &&
          (season.status === MediaStatus.AVAILABLE ||
            season.status === MediaStatus.PARTIALLY_AVAILABLE)
      )
      .map((season) => {
        const resolution = resolutions.get(season.seasonNumber);
        const name =
          tv.seasons.find((s) => s.seasonNumber === season.seasonNumber)
            ?.name ?? `Season ${season.seasonNumber}`;
        let note: string;
        let selectable = false;
        if (requested.has(season.seasonNumber)) {
          note = intl.formatMessage(messages.seasonrequested);
        } else if (resolution === undefined) {
          note = intl.formatMessage(messages.seasonunknown);
        } else if (resolution >= 1080) {
          note = intl.formatMessage(messages.seasonalready1080);
        } else {
          note = intl.formatMessage(messages.seasoncurrent, { resolution });
          selectable = true;
        }
        return { seasonNumber: season.seasonNumber, name, note, selectable };
      })
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
  }, [data, type, intl]);

  const toggleSeason = (seasonNumber: number) => {
    setSelectedSeasons((current) =>
      current.includes(seasonNumber)
        ? current.filter((sn) => sn !== seasonNumber)
        : [...current, seasonNumber]
    );
  };

  const sendRequest = useCallback(async () => {
    setIsUpdating(true);
    try {
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        mediaType: type,
        tvdbId:
          type === 'tv' ? (data as TvDetails)?.externalIds?.tvdbId : undefined,
        is4k: false,
        isUpgrade: true,
        seasons:
          type === 'tv'
            ? [...selectedSeasons].sort((a, b) => a - b)
            : undefined,
      });
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      if (response.data) {
        if (onComplete) {
          onComplete(
            response.data.status === MediaRequestStatus.PENDING
              ? MediaStatus.PENDING
              : MediaStatus.PROCESSING
          );
        }
        addToast(
          <span>
            {intl.formatMessage(messages.upgradeSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.upgradeerror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  }, [data, type, title, selectedSeasons, onComplete, addToast, intl]);

  const okText = isUpdating
    ? intl.formatMessage(globalMessages.requesting)
    : type === 'tv'
      ? selectedSeasons.length === 0
        ? intl.formatMessage(messages.selectseason)
        : intl.formatMessage(messages.upgradeseasons, {
            seasonCount: selectedSeasons.length,
          })
      : intl.formatMessage(messages.requestupgrade);

  return (
    <Modal
      loading={!data && !error}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={
        isUpdating || !data || (type === 'tv' && selectedSeasons.length === 0)
      }
      title={intl.formatMessage(messages.upgradetitle)}
      subTitle={title}
      okText={okText}
      okButtonType="primary"
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      <div className="mt-6">
        <Alert
          title={intl.formatMessage(messages.upgradeexplainer)}
          type="info"
        />
      </div>
      {type === 'tv' && (
        <div className="mt-4">
          {(data as TvDetails)?.currentQualityProfile && (
            <p className="mb-2 text-sm text-gray-400">
              {intl.formatMessage(messages.currentprofile, {
                profile: (data as TvDetails).currentQualityProfile,
              })}
            </p>
          )}
          <p className="mb-2 font-semibold text-gray-200">
            {intl.formatMessage(messages.whichseasons)}
          </p>
          <div className="overflow-hidden rounded-md border border-gray-700">
            {seasonRows.map((row) => (
              <label
                key={`upgrade-season-${row.seasonNumber}`}
                className={`flex items-center justify-between border-b border-gray-700 px-4 py-2 text-sm last:border-b-0 ${
                  row.selectable
                    ? 'cursor-pointer text-gray-100 hover:bg-gray-700'
                    : 'cursor-not-allowed text-gray-500'
                }`}
              >
                <span className="flex items-center">
                  <input
                    type="checkbox"
                    className="mr-3 h-4 w-4 rounded border-gray-600 bg-gray-800 text-indigo-600 disabled:opacity-40"
                    disabled={!row.selectable}
                    checked={selectedSeasons.includes(row.seasonNumber)}
                    onChange={() => toggleSeason(row.seasonNumber)}
                  />
                  {row.name}
                </span>
                <span className="ml-4 whitespace-nowrap text-xs">
                  {row.note}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default UpgradeRequestModal;
