# frozen_string_literal: true

require_relative "ui/version"

module Stimeo
  # The stimeo-ui gem is distribution only: it bundles the prebuilt JS
  # (dist/, identical to the npm package) and the `stimeo:install`
  # generator that vendors it into a Rails app. All behavior lives in
  # the JS; there is no Ruby runtime component.
  module UI
    # Gem root — inside the packaged gem, dist/ sits alongside lib/.
    ROOT = File.expand_path("../..", __dir__)

    # The prebuilt JS payload shipped inside the gem.
    def self.dist_dir
      File.join(ROOT, "dist")
    end
  end
end
