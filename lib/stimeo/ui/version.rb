# frozen_string_literal: true

module Stimeo
  module UI
    # Kept in lockstep with package.json (stable versions share the same
    # notation; a prerelease maps npm `-beta.N` ⇔ gem `.pre.beta.N` because
    # RubyGems forbids dashes). Bump both together — see RELEASING.md for
    # the synchronized release procedure.
    VERSION = "0.2.0"
  end
end
