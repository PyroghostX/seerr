import CachedImage from '@app/components/Common/CachedImage';
import useClickOutside from '@app/hooks/useClickOutside';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon, UsersIcon } from '@heroicons/react/24/solid';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { useCallback, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestList.UserFilter', {
  allUsers: 'All Users',
  noUsers: 'No Users',
  someUsers: '{count, plural, one {# User} other {# Users}}',
  selectAll: 'Select All',
  selectNone: 'Select None',
});

interface UserFilterProps {
  /** null = every user (no filter); [] = nobody. */
  selected: number[] | null;
  onChange: (selected: number[] | null) => void;
}

/**
 * Request list user picker: a dropdown of every user with a checkbox each,
 * plus Select All / Select None. Hidden when the user list can't be read
 * (it needs the Manage Users permission).
 */
const UserFilter = ({ selected, onChange }: UserFilterProps) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const { data, error } = useSWR<UserResultsResponse>(
    '/api/v1/user?take=1000&sort=displayname'
  );

  if (error || !data) {
    return null;
  }

  const users = data.results;
  const allIds = users.map((u) => u.id);
  const isOn = (id: number) => selected === null || selected.includes(id);

  const toggle = (id: number) => {
    const current = selected ?? allIds;
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    // Every user ticked is the same as no filter, and stays that way when
    // new users join.
    onChange(allIds.every((x) => next.includes(x)) ? null : next);
  };

  const label =
    selected === null
      ? intl.formatMessage(messages.allUsers)
      : selected.length === 0
        ? intl.formatMessage(messages.noUsers)
        : selected.length === 1
          ? (users.find((u) => u.id === selected[0])?.displayName ??
            intl.formatMessage(messages.someUsers, { count: 1 }))
          : intl.formatMessage(messages.someUsers, { count: selected.length });

  return (
    <div
      ref={ref}
      className="relative mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0"
    >
      <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
        <UsersIcon className="h-6 w-6" />
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-[9rem] items-center justify-between rounded-r-md border border-gray-500 bg-gray-700 px-3 py-2 text-left text-sm text-white sm:w-auto"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="ml-2 h-4 w-4 flex-shrink-0 text-gray-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[16rem] rounded-md border border-gray-600 bg-gray-800 shadow-lg sm:w-72">
          <div className="flex justify-between border-b border-gray-700 px-3 py-2 text-sm">
            <button
              type="button"
              className="text-indigo-400 hover:text-indigo-300"
              onClick={() => onChange(null)}
            >
              {intl.formatMessage(messages.selectAll)}
            </button>
            <button
              type="button"
              className="text-indigo-400 hover:text-indigo-300"
              onClick={() => onChange([])}
            >
              {intl.formatMessage(messages.selectNone)}
            </button>
          </div>
          <ul className="max-h-80 overflow-y-auto py-1" role="listbox">
            {users.map((u) => (
              <li key={u.id}>
                <label className="flex cursor-pointer items-center px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700">
                  <input
                    type="checkbox"
                    className="mr-3 h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600"
                    checked={isOn(u.id)}
                    onChange={() => toggle(u.id)}
                  />
                  <CachedImage
                    type="avatar"
                    src={u.avatar}
                    alt=""
                    className="mr-2 h-6 w-6 flex-shrink-0 rounded-full object-cover"
                    width={24}
                    height={24}
                  />
                  <span className="flex-grow truncate">{u.displayName}</span>
                  <span className="ml-2 text-xs text-gray-400">
                    {u.requestCount}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default UserFilter;
